import { basename, isAbsolute, join } from "node:path";
import {
  defaultHeadlessRun,
  unwrapClaudeStream,
  type HeadlessRun,
} from "../backends/headless";
import {
  defaultObservableDeps,
  discardPreparedObservableLeg,
  discardObservableLeg,
  reconcileObservableLeg,
  type ObservableAdapterDeps,
  type ObservableLegResult,
} from "../backends/observable";
import { errorDetail, WuxReviewError } from "../runtime/errors";
import { parseReport } from "./prompt";
import {
  prepareReviewRoundFinalization,
  type FinalizeReviewRoundInput,
} from "./pipeline";
import { commitObservableFinalization } from "./observable-finalization";
import {
  acquireObservableRecoveryLock,
  defaultObservableRoundStore,
  sessionStateSha256,
  type ObservableRoundRecord,
  type ObservableRoundStore,
} from "./observable-lifecycle";
import {
  defaultSessionStore,
  type SessionStore,
} from "./session-state";
import { consolidate, type VerdictEnvelope } from "./consolidate";
import { observableAttemptChildName } from "./observable-attempt";
import type {
  LegExecutionEvidence,
  ReviewerName,
  SessionState,
} from "./types";

export interface ObservableRecoveryDeps {
  roundStore: ObservableRoundStore;
  sessionStore: SessionStore;
  run: HeadlessRun;
  observable?: Partial<ObservableAdapterDeps>;
  // Explicitly injectable for tests or alternate stores. Supplying a custom
  // round store no longer silently disables cross-process serialization.
  acquireObservableLock: (reviewId: string) => Promise<() => Promise<void>>;
}

export interface TerminalCleanupOutcome {
  kind: "terminal-cleanup-completed";
  reviewId: string;
  state: "failed" | "timed_out" | "tainted";
  diagnostic: string;
}

export type ReconcileOutcome = VerdictEnvelope | TerminalCleanupOutcome;

export async function reconcileReview(
  reviewId: string,
  overrides: Partial<ObservableRecoveryDeps> = {},
): Promise<ReconcileOutcome> {
  const releaseLock = await (
    overrides.acquireObservableLock ?? acquireObservableRecoveryLock
  )(reviewId);
  try {
    return await reconcileReviewLocked(reviewId, overrides);
  } finally {
    await releaseLock?.();
  }
}

async function reconcileReviewLocked(
  reviewId: string,
  overrides: Partial<ObservableRecoveryDeps>,
): Promise<ReconcileOutcome> {
  const roundStore = overrides.roundStore ?? defaultObservableRoundStore;
  const sessionStore = overrides.sessionStore ?? defaultSessionStore;
  const record = await roundStore.load(reviewId);
  if (record === undefined) {
    throw new WuxReviewError(`observable round ${reviewId}: no recovery state found`);
  }
  const run = overrides.run ?? defaultHeadlessRun;
  const observable = {
    ...defaultObservableDeps(run),
    ...overrides.observable,
    run,
  };
  const terminalState = record.state;
  if (
    terminalState === "tainted"
    || terminalState === "failed"
    || terminalState === "timed_out"
  ) {
    let terminalDiagnostic = record.diagnostic;
    if (record.cleanupPending === true) {
      try {
        await discardRound(record, observable);
      } catch (cleanupError) {
        const diagnostic = `observable round ${reviewId}: terminal cleanup retry failed: ${errorDetail(cleanupError)}`;
        await roundStore.save({
          ...record,
          cleanupPending: true,
          updatedAt: new Date().toISOString(),
          diagnostic,
        }).catch(() => undefined);
        throw new WuxReviewError(diagnostic);
      }
      terminalDiagnostic = `${record.diagnostic ?? `observable round ${reviewId} is ${record.state}`}; terminal cleanup retry completed`;
      await roundStore.save({
        ...record,
        cleanupPending: false,
        updatedAt: new Date().toISOString(),
        diagnostic: terminalDiagnostic,
      });
      return {
        kind: "terminal-cleanup-completed",
        reviewId,
        state: terminalState,
        diagnostic: terminalDiagnostic,
      };
    }
    throw new WuxReviewError(
      `observable round ${reviewId} is ${record.state} and cannot be reconciled${terminalDiagnostic === undefined ? "" : `: ${terminalDiagnostic}`}`,
    );
  }
  if (["completed", "reconciled"].includes(record.state)) {
    throw new WuxReviewError(
      `observable round ${reviewId} was already ${record.state} and cannot be replayed`,
    );
  }

  let validatedEvidence = false;
  let journalRecord = record;
  try {
    const prior = record.sessionMode
      ? await loadReliableRecoverySession(sessionStore, record.reviewId)
      : undefined;
    if (
      record.sessionMode
      && record.finalization !== undefined
      && sessionStateSha256(prior) === record.finalization.sessionStateSha256
    ) {
      const results = prior!.results;
      const envelope = consolidate(
        results.claude,
        results.codex,
        record.reviewId,
      );
      envelope.round = record.round;
      await roundStore.save({
        ...record,
        state: "reconciled",
        updatedAt: new Date().toISOString(),
        diagnostic: "completed a previously committed observable finalization",
      });
      return envelope;
    }
    if (sessionStateSha256(prior) !== record.priorStateSha256) {
      throw new WuxReviewError(
        `observable round ${reviewId}: session state changed since launch; refusing stale or cross-round evidence`,
      );
    }
    const expectedRound = record.sessionMode ? (prior?.round ?? 0) + 1 : 1;
    if (record.round !== expectedRound) {
      throw new WuxReviewError(
        `observable round ${reviewId}: recovery round ${record.round} does not follow session round ${expectedRound - 1}`,
      );
    }
    validateAttempts(record);

    const attempts = await Promise.allSettled([
      reconcileAttempts(record, "claude", observable),
      reconcileAttempts(record, "codex", observable),
    ]);
    const failures = attempts.filter(
      (attempt): attempt is PromiseRejectedResult => attempt.status === "rejected",
    );
    if (failures.length > 0) {
      const error = preferredRecoveryError(failures.map((failure) => failure.reason));
      throw error;
    }
    const fulfilled = attempts.filter(
      (attempt): attempt is PromiseFulfilledResult<ObservableLegResult[]> =>
        attempt.status === "fulfilled",
    );
    const claudeAttempts = fulfilled[0]!.value;
    const codexAttempts = fulfilled[1]!.value;
    const claudeLeg = claudeAttempts[0]!;
    if (claudeLeg.code !== 0) {
      throw new WuxReviewError(
        `${record.expected.claudeChildName} observable reviewer leg exited ${claudeLeg.code}; evidence: ${record.evidence.claude[0]!.evidencePath}`,
      );
    }
    const claude = parseReport("claude", unwrapClaudeStream(claudeLeg.stdout));
    const codexIndex = successfulCodexAttempt(record, codexAttempts);
    const codexLeg = codexAttempts[codexIndex]!;
    const codexOutput = codexLeg.structuredOutput;
    if (codexOutput === undefined || codexOutput.trim() === "") {
      throw new WuxReviewError(
        `${record.evidence.codex[codexIndex]!.childName} observable reviewer leg produced no final message; evidence: ${record.evidence.codex[codexIndex]!.evidencePath}`,
      );
    }
    const codex = parseReport("codex", codexOutput);
    validatedEvidence = true;
    const finalize: FinalizeReviewRoundInput = {
      sessionId: record.reviewId,
      round: record.round,
      sessionMode: record.sessionMode,
      prior,
      ledger: record.ledger,
      claude,
      codex,
      evidence: record.evidence,
    };
    const prepared = prepareReviewRoundFinalization(finalize);
    await commitObservableFinalization({
      record,
      prepared,
      finalizingDiagnostic: "validated reviewer evidence; committing final session state",
      terminalState: "reconciled",
      terminalDiagnostic: "reconciled from existing child evidence with zero model calls",
      saveRound: async (next) => {
        journalRecord = next;
        await roundStore.save(next);
      },
      saveSession: (sessionId, state) => sessionStore.save(sessionId, state),
    });
    return prepared.envelope;
  } catch (error) {
    let state = lifecycleState(error);
    let terminalError = error;
    let cleanupPending = false;
    if (validatedEvidence && state === "failed") {
      state = "interrupted";
      terminalError = Object.assign(
        new WuxReviewError(
          `observable round ${reviewId}: validated evidence could not be finalized; retry reconciliation: ${errorDetail(error)}`,
        ),
        { state: "interrupted" as const },
      );
    }
    if (state !== "interrupted") {
      try {
        await discardRound(journalRecord, observable);
      } catch (cleanupError) {
        cleanupPending = true;
        terminalError = new WuxReviewError(
          `${errorDetail(error)}; terminal cleanup failed: ${errorDetail(cleanupError)}`,
        );
      }
    }
    await roundStore.save({
      ...journalRecord,
      state,
      cleanupPending,
      updatedAt: new Date().toISOString(),
      diagnostic: errorDetail(terminalError),
    }).catch(() => undefined);
    throw terminalError;
  }
}

async function loadReliableRecoverySession(
  store: SessionStore,
  reviewId: string,
): Promise<SessionState | undefined> {
  if (store.loadForCompare === undefined) return store.load(reviewId);
  const snapshot = await store.loadForCompare(reviewId);
  if (snapshot.reliable) return snapshot.state;
  throw Object.assign(
    new WuxReviewError(
      `observable round ${reviewId}: session state could not be read reliably; retry reconciliation without discarding evidence`,
    ),
    { state: "interrupted" as const },
  );
}

async function reconcileAttempts(
  record: ObservableRoundRecord,
  reviewer: ReviewerName,
  observable: ObservableAdapterDeps,
): Promise<ObservableLegResult[]> {
  const settled = await Promise.allSettled(
    record.evidence[reviewer].map((evidence) =>
      reconcileObservableLeg(
        {
          reviewId: record.reviewId,
          round: record.round,
          evidence,
        },
        observable,
      )),
  );
  const failures = settled.filter(
    (attempt): attempt is PromiseRejectedResult =>
      attempt.status === "rejected",
  );
  if (failures.length > 0) {
    throw preferredRecoveryError(failures.map((failure) => failure.reason));
  }
  await cleanupSharedRecoveryResources(record.evidence[reviewer], observable);
  return settled.map(
    (attempt) => (attempt as PromiseFulfilledResult<ObservableLegResult>).value,
  );
}

function validateAttempts(record: ObservableRoundRecord): void {
  validateReviewerAttempts(
    record,
    "claude",
    record.expected.claudeChildName,
  );
  validateReviewerAttempts(
    record,
    "codex",
    record.expected.codexChildName,
  );
  if (record.evidence.claude.length !== 1) {
    throw new WuxReviewError(
      `observable round ${record.reviewId}: Claude recovery requires exactly one attempt`,
    );
  }
  if (record.evidence.codex.length === 0) {
    throw new WuxReviewError(
      `observable round ${record.reviewId}: Codex recovery evidence is incomplete`,
    );
  }
  const identities = {
    resultId: new Set<string>(),
    resultPath: new Set<string>(),
    evidencePath: new Set<string>(),
    transientBase: new Set<string>(),
  };
  for (const entry of [...record.evidence.claude, ...record.evidence.codex]) {
    if (
      !isAbsolute(entry.evidencePath)
      || basename(entry.evidencePath) !== entry.childName
      || entry.resultPath !== join(entry.evidencePath, "result.json")
      || entry.transientBase === undefined
      || !isAbsolute(entry.transientBase)
      || basename(entry.transientBase) !== entry.childName
      || identities.resultId.has(entry.resultId)
      || identities.resultPath.has(entry.resultPath)
      || identities.evidencePath.has(entry.evidencePath)
      || identities.transientBase.has(entry.transientBase)
    ) {
      throw new WuxReviewError(
        `observable round ${record.reviewId}: evidence identity is duplicated, unsafe, stale, or cross-leg`,
      );
    }
    identities.resultId.add(entry.resultId);
    identities.resultPath.add(entry.resultPath);
    identities.evidencePath.add(entry.evidencePath);
    identities.transientBase.add(entry.transientBase);
  }
}

function validateReviewerAttempts(
  record: ObservableRoundRecord,
  reviewer: ReviewerName,
  baseChild: string,
): void {
  const entries = record.evidence[reviewer];
  const identities = new Set<string>();
  entries.forEach((entry, index) => {
    const attempt = index + 1;
    const expectedChild = observableAttemptChildName(baseChild, attempt);
    if (
      entry.reviewer !== reviewer
      || entry.attempt !== attempt
      || entry.childName !== expectedChild
      || entry.transientBase === undefined
      || identities.has(entry.resultId)
    ) {
      throw new WuxReviewError(
        `observable round ${record.reviewId}: ${reviewer} evidence is duplicated, stale, or cross-leg`,
      );
    }
    identities.add(entry.resultId);
  });
}

function successfulCodexAttempt(
  record: ObservableRoundRecord,
  attempts: ObservableLegResult[],
): number {
  let successful = -1;
  attempts.forEach((attempt, index) => {
    const hasOutput = attempt.structuredOutput !== undefined
      && attempt.structuredOutput.trim() !== "";
    if (attempt.code === 0 && hasOutput) {
      if (successful !== -1 || index !== attempts.length - 1) {
        throw new WuxReviewError(
          `observable round ${record.reviewId}: duplicate or replayed Codex result`,
        );
      }
      successful = index;
    } else if (index === attempts.length - 1) {
      throw new WuxReviewError(
        `${record.evidence.codex[index]!.childName} observable reviewer leg has no successful completed result; evidence: ${record.evidence.codex[index]!.evidencePath}`,
      );
    }
  });
  if (successful === -1) {
    throw new WuxReviewError(
      `observable round ${record.reviewId}: Codex recovery evidence is incomplete`,
    );
  }
  return successful;
}

function lifecycleState(
  error: unknown,
): ObservableRoundRecord["state"] {
  if (
    error instanceof Error
    && "state" in error
    && ["failed", "timed_out", "tainted", "interrupted"].includes(String(error.state))
  ) {
    return error.state as ObservableRoundRecord["state"];
  }
  return "failed";
}

function preferredRecoveryError(errors: unknown[]): unknown {
  for (const state of ["tainted", "timed_out", "failed", "interrupted"] as const) {
    const match = errors.find((error) =>
      error instanceof Error
      && "state" in error
      && error.state === state);
    if (match !== undefined) return match;
  }
  return errors[0];
}

async function discardRound(
  record: ObservableRoundRecord,
  observable: ObservableAdapterDeps,
): Promise<void> {
  const evidence = [...record.evidence.claude, ...record.evidence.codex];
  const recordedChildren = new Set(evidence.map((entry) => entry.childName));
  const prepared = record.prepared ?? {
    claude: [record.expected.claudeChildName],
    codex: [record.expected.codexChildName],
  };
  const preparedChildren: Array<{
    childName: string;
    reviewer: ReviewerName;
  }> = [];
  const seenPrepared = new Set<string>();
  for (const reviewer of ["claude", "codex"] as const) {
    for (const childName of prepared[reviewer]) {
      if (!recordedChildren.has(childName) && !seenPrepared.has(childName)) {
        seenPrepared.add(childName);
        preparedChildren.push({ childName, reviewer });
      }
    }
  }
  const settled = await Promise.allSettled(
    [
      ...evidence.map((entry) =>
        discardObservableLeg(
          {
            reviewId: record.reviewId,
            round: record.round,
            evidence: entry,
          },
          observable,
        )),
      ...preparedChildren.map(({ childName, reviewer }) =>
        discardPreparedObservableLeg(childName, reviewer, observable)),
    ],
  );
  const failure = settled.find(
    (result): result is PromiseRejectedResult => result.status === "rejected",
  );
  if (failure !== undefined) {
    throw new WuxReviewError(
      `observable round ${record.reviewId}: terminal cleanup failed: ${errorDetail(failure.reason)}`,
    );
  }
  await cleanupSharedRecoveryResources(evidence, observable);
}

async function cleanupSharedRecoveryResources(
  evidence: LegExecutionEvidence[],
  observable: ObservableAdapterDeps,
): Promise<void> {
  const paths = new Set<string>();
  for (const record of evidence) {
    for (const path of record.cleanupFiles ?? []) paths.add(path);
    if (record.cleanupDir !== undefined) paths.add(record.cleanupDir);
  }
  try {
    await Promise.all([...paths].map((path) => observable.rm(path)));
  } catch (error) {
    throw new WuxReviewError(
      `observable shared recovery cleanup failed: ${errorDetail(error)}`,
    );
  }
}
