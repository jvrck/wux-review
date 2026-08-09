import { randomUUID } from "node:crypto";
import { loadConfig as defaultLoadConfig } from "./config";
import { consolidate, findingKey, type VerdictEnvelope } from "./consolidate";
import { getDiff as defaultGetDiff, type ReviewDiff } from "./diff";
import { resolveLenses, type Lens } from "./lenses";
import {
  runReviewers as defaultRunReviewers,
  type DualReviewResult,
  type Reviewers,
  type RunReviewersOptions,
} from "./reviewers";
import { applyRefutationLedger, mergeLedger } from "./refutation";
import { defaultSessionStore, type SessionStore } from "./session-state";
import {
  appendPreparedChild,
  appendRoundEvidence,
  acquireObservableRecoveryLock,
  defaultObservableRoundStore,
  sessionStateSha256,
  type ObservableRoundRecord,
  type ObservableRoundStore,
} from "./observable-lifecycle";
import { commitObservableFinalization } from "./observable-finalization";
import { applyStickyApprove, nextStickyKeys } from "./sticky";
import { resolveTarget, type Target } from "./target";
import type {
  Refutation,
  RefutationEntry,
  ReviewResult,
  ReviewRoundEvidence,
  SessionState,
} from "./types";
import { errorDetail, WuxReviewError } from "../runtime/errors";

class SessionStateConflictError extends WuxReviewError {}

// The single review pipeline shared by every caller (CLI and the MCP tool), so
// there is exactly one place that resolves config → lenses → target → diff →
// the two reviewers → the consolidated verdict. Side effects (rendering, PR
// posting) stay with the caller.
export interface ReviewInput {
  ref?: string;
  pr?: number;
  lenses?: string[];
  session?: string;
  cwd?: string;
  // Execution mode selected by the caller. User-facing CLI/MCP callers pass
  // observable=true by default; false is the explicit direct rollback path.
  inspect?: boolean;
  signal?: AbortSignal;
  // Worker-supplied refutations (#101), from `--refutations <file>`. Each is keyed
  // and merged into the per-leg session ledger this round, shown to the leg, and
  // used to demote a refuted-and-still-unproven must-fix it re-raises.
  refutations?: Refutation[];
}

export interface ReviewDeps {
  runReviewers?: (diff: string, lenses: Lens[], options?: RunReviewersOptions) => Promise<DualReviewResult>;
  loadConfig?: typeof defaultLoadConfig;
  // Reviewer backends forwarded to the default `runReviewers` (so a test can
  // exercise real prompt-threading + parsing with mock legs). Ignored when
  // `runReviewers` is injected wholesale.
  backends?: Reviewers;
  // Per-session prior-findings persistence (#91); defaults to the on-disk store.
  sessionStore?: SessionStore;
  // The diff source; injectable so the pipeline is testable end-to-end without git.
  getDiff?: (target: Target) => Promise<ReviewDiff>;
  observableRoundStore?: ObservableRoundStore;
  acquireObservableLock?: (reviewId: string) => Promise<() => Promise<void>>;
}

export async function runReview(input: ReviewInput, deps: ReviewDeps = {}): Promise<VerdictEnvelope> {
  if (input.ref !== undefined && input.pr !== undefined) {
    throw new WuxReviewError("provide either a ref or pr, not both");
  }
  throwIfObservableReviewAborted(input);

  const loadConfig = deps.loadConfig ?? defaultLoadConfig;
  const config = await loadConfig();
  const lenses = resolveLenses({ cliLenses: input.lenses, config });
  const target = resolveTarget({ ref: input.ref, pr: input.pr });
  const getDiff = deps.getDiff ?? defaultGetDiff;
  // The diff is the FULL cumulative base...head change for the target, computed
  // identically regardless of session state (#94): a `--session` re-review is fed
  // the same full diff as the first review — never just the commits since the last
  // round — so it can never false-flag earlier-commit content (e.g. tests) as
  // missing. Prior findings (loaded below) ride along the prompt as context only;
  // they do not scope this diff.
  const { diff } = await getDiff(target);
  throwIfObservableReviewAborted(input);

  // An explicit session id (CLI `--session`, MCP `session`) means session mode:
  // this is a re-review that reuses prior context. Outside session mode nothing
  // below persists or loads, and the review is byte-for-byte the one-shot path.
  const sessionMode = input.session !== undefined;
  const store = deps.sessionStore ?? defaultSessionStore;
  const observableReviewId = input.inspect === true
    ? input.session ?? `obs${randomUUID().replaceAll("-", "").slice(0, 12)}`
    : input.session;
  // Every operation that can read or write a named session participates in the
  // same cross-process lock as observable launch/recovery. The lock begins before
  // the prior-state read and remains held through final persistence, so a direct
  // round cannot race an observable round and overwrite results derived from a
  // stale snapshot. Observable one-shot rounds still lock their generated recovery
  // id so launch and reconciliation remain mutually exclusive.
  const lockReviewId = sessionMode ? input.session : observableReviewId;
  const releaseObservableLock = lockReviewId === undefined
    ? undefined
    : await (deps.acquireObservableLock ?? acquireObservableRecoveryLock)(
        lockReviewId,
      );
  try {
    const prior = sessionMode ? await store.load(input.session!) : undefined;
    // Thread each leg its OWN prior findings (never the other's — legs stay
    // independent). `undefined` on the first round / one-shot path leaves the prompt
    // unchanged; a leg that approved with no findings yields an (empty) array, a
    // distinct "you approved last round" signal to the prompt.
    const priorFindings =
      prior === undefined
        ? undefined
        : { claude: prior.results.claude.findings, codex: prior.results.codex.findings };

    // The round for this review (#100): 1-based, from the session state. Computed
    // before running the legs because new refutations are stamped with it and the
    // ledger is shown to each leg in its prompt (#101).
    const round = sessionMode ? (prior?.round ?? 0) + 1 : 1;

    // Refutation ledger (#101): the prior per-leg ledger plus any refutations supplied
    // this round (from `--refutations`), keyed and deduped. Scoped to session mode —
    // the ledger lives in session state and is meaningless one-shot (the CLI also
    // rejects `--refutations` without `--session`). Shown to each leg before it
    // reviews, and used below to demote a refuted must-fix re-raised without proof.
    const priorLedger = prior?.ledger ?? { claude: [], codex: [] };
    // The prior round's per-leg findings (same source as `priorFindings`, which is
    // undefined exactly when `prior` is absent): mergeLedger captures each refuted
    // finding's repro from them (so a re-raise must supply a NEW one), and the
    // demotion guard uses their keys to only demote a genuine re-raise, never a first
    // appearance.
    const priorLegFindings = priorFindings ?? { claude: [], codex: [] };
    const ledger = sessionMode
      ? mergeLedger(priorLedger, input.refutations ?? [], round, priorLegFindings)
      : { claude: [], codex: [] };

    const runReviewers = deps.runReviewers ?? defaultRunReviewers;
    const roundStore = deps.observableRoundStore ?? defaultObservableRoundStore;
    let recoveryRecord: ObservableRoundRecord | undefined;
    let recoveryQueue = Promise.resolve();
    const serializeRecovery = (operation: () => Promise<void>): Promise<void> => {
      const next = recoveryQueue.then(operation);
      recoveryQueue = next.catch(() => undefined);
      return next;
    };
    // The shared lock excludes current direct/observable/recovery operations.
    // Keep this hash check for the narrow cross-version window where an older
    // installed direct reviewer does not yet participate in the shared lock.
    if (input.inspect === true && sessionMode) {
      const current = await loadReliableSessionState(
        input.session!,
        store,
        `observable round ${observableReviewId}`,
      );
      if (sessionStateSha256(current) !== sessionStateSha256(prior)) {
        throw new WuxReviewError(
          `observable round ${observableReviewId}: session state changed before launch; retry with the latest round`,
        );
      }
    }
    const { claude, codex, sessionId, evidence } = await runReviewers(diff, lenses, {
      models: { claude: config.reviewers?.claude?.model, codex: config.reviewers?.codex?.model },
      sessionId: observableReviewId,
      persist: sessionMode,
      cwd: input.cwd,
      inspect: input.inspect,
      round,
      backends: deps.backends,
      priorFindings,
      refutationLedger: { claude: ledger.claude, codex: ledger.codex },
      signal: input.signal,
      prepareObservableRound: input.inspect === true
        ? (descriptor) => serializeRecovery(async () => {
            await roundStore.prune();
            const existing = await roundStore.load(descriptor.reviewId);
            if (
              existing !== undefined
              && (
                existing.cleanupPending === true
                || [
                  "pending",
                  "running",
                  "interrupted",
                  "finalizing",
                ].includes(existing.state)
              )
            ) {
              throw new WuxReviewError(
                `observable round ${descriptor.reviewId} is ${existing.state}; reconcile it before launching another model call`,
              );
            }
            const at = new Date().toISOString();
            recoveryRecord = {
              version: 1,
              reviewId: descriptor.reviewId,
              round: descriptor.round,
              executionId: descriptor.executionId,
              sessionMode,
              priorStateSha256: sessionStateSha256(prior),
              expected: {
                claudeChildName: descriptor.claudeChildName,
                codexChildName: descriptor.codexChildName,
              },
              prepared: {
                claude: [descriptor.claudeChildName],
                codex: [descriptor.codexChildName],
              },
              ledger,
              evidence: { claude: [], codex: [] },
              state: "pending",
              startedAt: at,
              updatedAt: at,
            };
            await roundStore.save(recoveryRecord);
          })
        : undefined,
      recordObservablePreparedChild: input.inspect === true
        ? (reviewer, childName, attempt) => serializeRecovery(async () => {
            if (recoveryRecord === undefined) {
              throw new WuxReviewError(
                `${childName} observable reviewer leg: recovery state was not prepared`,
              );
            }
            recoveryRecord = appendPreparedChild(
              recoveryRecord,
              reviewer,
              childName,
              attempt,
              new Date().toISOString(),
            );
            await roundStore.save(recoveryRecord);
          })
        : undefined,
      recordObservableEvidence: input.inspect === true
        ? (record) => serializeRecovery(async () => {
            if (recoveryRecord === undefined) {
              throw new WuxReviewError(
                `${record.childName} observable reviewer leg: recovery state was not prepared`,
              );
            }
            recoveryRecord = appendRoundEvidence(
              recoveryRecord,
              record,
              new Date().toISOString(),
            );
            await roundStore.save(recoveryRecord);
          })
        : undefined,
      finishObservableRound: input.inspect === true
        ? (state, diagnostic, cleanupPending) => serializeRecovery(async () => {
            if (recoveryRecord === undefined) return;
            // Successful reviewer collection is not a committed round. Keep the
            // evidence replayable until the pipeline journals the exact target
            // session hash and results below.
            if (state === "completed") return;
            const journalState = cleanupPending === true
              && !["failed", "timed_out", "tainted"].includes(state)
              ? "failed"
              : state;
            recoveryRecord = {
              ...recoveryRecord,
              state: journalState,
              cleanupPending: cleanupPending === true,
              updatedAt: new Date().toISOString(),
              ...(diagnostic === undefined ? {} : { diagnostic }),
            };
            await roundStore.save(recoveryRecord);
          })
        : undefined,
    });

    const finalization: FinalizeReviewRoundInput = {
      sessionId,
      round,
      sessionMode,
      prior,
      ledger,
      claude,
      codex,
      evidence,
    };
    if (input.inspect !== true) {
      return await finalizeReviewRound(finalization, store);
    }
    if (recoveryRecord === undefined) {
      throw new WuxReviewError(
        `observable round ${sessionId}: recovery state was not prepared`,
      );
    }
    const prepared = prepareReviewRoundFinalization(finalization);
    try {
      await commitObservableFinalization({
        record: recoveryRecord,
        prepared,
        finalizingDiagnostic: "validated reviewer results; committing final session state",
        terminalState: "completed",
        terminalDiagnostic: "observable reviewer results and session state committed",
        saveRound: async (record) => {
          recoveryRecord = record;
          await serializeRecovery(() => roundStore.save(record));
        },
        saveSession: (reviewId, state) => store.save(reviewId, state),
        afterFinalizingJournal: async () => {
          throwIfObservableReviewAborted(input, "during finalization");
          if (prepared.sessionState !== undefined) {
            await assertSessionStateUnchanged(sessionId, prior, store);
          }
          throwIfObservableReviewAborted(input, "during finalization");
        },
        afterSessionWrite: () => {
          // If persistence completed as the signal arrived, leave the journal
          // interrupted. Reconciliation recognizes the committed target hash
          // and completes without replaying either model.
          throwIfObservableReviewAborted(input, "during finalization");
        },
        afterTerminalJournal: () => {
          // A signal racing the completed-journal write is converted back to an
          // interrupted journal below, keeping zero-call recovery explicit.
          throwIfObservableReviewAborted(input, "during finalization");
        },
      });
      return prepared.envelope;
    } catch (error) {
      if (error instanceof SessionStateConflictError) {
        recoveryRecord = {
          ...recoveryRecord,
          state: "failed",
          updatedAt: new Date().toISOString(),
          diagnostic: error.message,
        };
        await serializeRecovery(() => roundStore.save(recoveryRecord!))
          .catch(() => undefined);
        throw error;
      }
      const interrupted = Object.assign(
        new WuxReviewError(
          `observable round ${sessionId}: validated results could not be finalized; reconcile the existing evidence: ${errorDetail(error)}`,
        ),
        { state: "interrupted" as const },
      );
      recoveryRecord = {
        ...recoveryRecord,
        state: "interrupted",
        updatedAt: new Date().toISOString(),
        diagnostic: interrupted.message,
      };
      await serializeRecovery(() => roundStore.save(recoveryRecord!))
        .catch(() => undefined);
      throw interrupted;
    }
  } finally {
    await releaseObservableLock?.();
  }
}

function throwIfObservableReviewAborted(
  input: ReviewInput,
  phase = "before child launch",
): void {
  if (input.inspect !== true || !input.signal?.aborted) return;
  throw Object.assign(
    new WuxReviewError(`observable review interrupted ${phase}`),
    { state: "interrupted" as const },
  );
}

export interface FinalizeReviewRoundInput {
  sessionId: string;
  round: number;
  sessionMode: boolean;
  prior?: SessionState;
  ledger: { claude: RefutationEntry[]; codex: RefutationEntry[] };
  claude: ReviewResult;
  codex: ReviewResult;
  evidence?: { claude: ReviewRoundEvidence["claude"]; codex: ReviewRoundEvidence["codex"] };
}

export interface PreparedReviewRound {
  envelope: VerdictEnvelope;
  results: { claude: ReviewResult; codex: ReviewResult };
  sessionState?: SessionState;
}

export function prepareReviewRoundFinalization(
  input: FinalizeReviewRoundInput,
): PreparedReviewRound {
  const priorFindings = input.prior === undefined
    ? { claude: [], codex: [] }
    : {
        claude: input.prior.results.claude.findings,
        codex: input.prior.results.codex.findings,
      };
  const priorSticky = input.prior?.sticky ?? { claude: [], codex: [] };
  const claudeStuck = applyStickyApprove(input.claude, new Set(priorSticky.claude));
  const codexStuck = applyStickyApprove(input.codex, new Set(priorSticky.codex));
  const priorKeys = {
    claude: new Set(priorFindings.claude.map(findingKey)),
    codex: new Set(priorFindings.codex.map(findingKey)),
  };
  const claudeResult = input.prior === undefined
    ? claudeStuck
    : applyRefutationLedger(claudeStuck, input.ledger.claude, priorKeys.claude);
  const codexResult = input.prior === undefined
    ? codexStuck
    : applyRefutationLedger(codexStuck, input.ledger.codex, priorKeys.codex);

  const envelope = consolidate(claudeResult, codexResult, input.sessionId);
  envelope.round = input.round;

  const sessionState = input.sessionMode
    ? {
        version: 1,
        round: input.round,
        results: { claude: claudeResult, codex: codexResult },
        sticky: {
          claude: nextStickyKeys(priorSticky.claude, claudeStuck),
          codex: nextStickyKeys(priorSticky.codex, codexStuck),
        },
        ledger: input.ledger,
        ...(
          input.evidence === undefined && (input.prior?.children?.length ?? 0) === 0
            ? {}
            : {
                children: input.evidence === undefined
                  ? input.prior!.children
                  : [
                      ...(input.prior?.children ?? []),
                      {
                        round: input.round,
                        claude: input.evidence.claude.map(publicObservableEvidence),
                        codex: input.evidence.codex.map(publicObservableEvidence),
                      },
                    ],
              }
        ),
      } satisfies SessionState
    : undefined;
  return {
    envelope,
    results: { claude: claudeResult, codex: codexResult },
    ...(sessionState === undefined ? {} : { sessionState }),
  };
}

export async function finalizeReviewRound(
  input: FinalizeReviewRoundInput,
  store: SessionStore = defaultSessionStore,
): Promise<VerdictEnvelope> {
  const prepared = prepareReviewRoundFinalization(input);
  if (prepared.sessionState !== undefined) {
    if (await canBestEffortPersistSession(input.sessionId, input.prior, store)) {
      await store.save(input.sessionId, prepared.sessionState).catch(() => undefined);
    }
  }
  return prepared.envelope;
}

async function canBestEffortPersistSession(
  sessionId: string,
  prior: SessionState | undefined,
  store: SessionStore,
): Promise<boolean> {
  let current: SessionState | undefined;
  try {
    if (store.loadForCompare !== undefined) {
      const snapshot = await store.loadForCompare(sessionId);
      if (!snapshot.reliable) {
        // The initial best-effort load already degraded a corrupt file to no
        // prior context. Under the shared session lock it is safe to replace
        // that known-invalid snapshot so later rounds self-heal. An I/O failure
        // remains ambiguous and must not authorize a write.
        return snapshot.corrupt === true && prior === undefined;
      }
      current = snapshot.state;
    } else {
      current = await store.load(sessionId);
    }
  } catch {
    // Direct-session persistence is advisory: a transient read failure cannot
    // invalidate two completed reviewer verdicts. Skip the write whenever the
    // guard cannot prove it is safe.
    return false;
  }
  // A known newer round is equally unsafe to overwrite, but direct-session
  // persistence remains advisory. Preserve the completed verdict and leave the
  // newer state untouched; strict observable rounds still fail closed below.
  return sessionStateSha256(current) === sessionStateSha256(prior);
}

async function assertSessionStateUnchanged(
  sessionId: string,
  prior: SessionState | undefined,
  store: SessionStore,
): Promise<void> {
  if (
    sessionStateSha256(await loadReliableSessionState(
      sessionId,
      store,
      `review session ${sessionId}`,
    ))
      === sessionStateSha256(prior)
  ) {
    return;
  }
  throw new SessionStateConflictError(
    `review session ${sessionId}: state changed while reviewers were running; refusing to overwrite the newer round`,
  );
}

async function loadReliableSessionState(
  sessionId: string,
  store: SessionStore,
  context: string,
): Promise<SessionState | undefined> {
  if (store.loadForCompare === undefined) return store.load(sessionId);
  const snapshot = await store.loadForCompare(sessionId);
  if (snapshot.reliable) return snapshot.state;
  throw new WuxReviewError(
    `${context}: session state could not be read reliably; refusing to continue`,
  );
}

function publicObservableEvidence(
  evidence: ReviewRoundEvidence["claude"][number],
): ReviewRoundEvidence["claude"][number] {
  const {
    ownedCleanupKey: _ownedCleanupKey,
    eventPrefix: _eventPrefix,
    wrapperExitedNormally: _wrapperExitedNormally,
    cleanupFiles: _cleanupFiles,
    cleanupDir: _cleanupDir,
    ...publicEvidence
  } = evidence;
  return publicEvidence;
}
