import { WUX_ALREADY_GONE_PATTERNS } from "../backends/observable";
import { run as defaultRun, type Run, type RunResult } from "../runtime/exec";
import { errorDetail, WuxReviewError } from "../runtime/errors";
import {
  acquireObservableRecoveryLock,
  defaultObservableRoundStore,
  type ObservableRoundRecord,
  type ObservableRoundStore,
} from "./observable-lifecycle";
import {
  sessionName,
  validateObservableChildName,
  validateObservablePrefix,
  validateSessionId,
} from "./reviewers";
import { defaultSessionStore, type SessionStore } from "./session-state";
import type { ReviewerName, SessionState } from "./types";

export type EndSessionChildStatus = "stopped" | "already-gone" | `failed: ${string}`;

export interface EndSessionChildReport {
  name: string;
  status: EndSessionChildStatus;
}

export interface EndSessionReport {
  sessionId: string;
  children: EndSessionChildReport[];
  removed: string[];
  nothingRecorded?: true;
}

export interface EndSessionDeps {
  roundStore?: ObservableRoundStore;
  acquireLock?: (reviewId: string) => Promise<() => Promise<void>>;
  observablePrefix?: string;
}

export class EndSessionFailure extends WuxReviewError {
  constructor(message: string, readonly report: EndSessionReport) {
    super(message);
  }
}

// Stop only runs proven by this session's durable state. This never lists Wux
// runs or guesses observable names, so a tampered record cannot broaden its
// authority.
export async function endSession(
  sessionId: string,
  run: Run = defaultRun,
  store: SessionStore = defaultSessionStore,
  deps: EndSessionDeps = {},
): Promise<EndSessionReport> {
  validateSessionId(sessionId);
  const roundStore = deps.roundStore ?? defaultObservableRoundStore;
  const observablePrefix = validateObservablePrefix(
    deps.observablePrefix ?? process.env.WUX_REVIEW_OBSERVABLE_PREFIX ?? "wuxr",
  );
  const releaseLock = await (deps.acquireLock ?? acquireObservableRecoveryLock)(sessionId);
  try {
    const stateSnapshot = store.inspectForEndSession === undefined
      ? { state: await store.load(sessionId), files: [] }
      : await store.inspectForEndSession(sessionId);
    const roundSnapshot = roundStore.inspectForEndSession === undefined
      ? { record: await roundStore.load(sessionId), files: [] }
      : await roundStore.inspectForEndSession(sessionId);
    const states = [stateSnapshot.state, stateSnapshot.temporaryState]
      .filter((state): state is SessionState => state !== undefined);
    const journals = [roundSnapshot.record, roundSnapshot.temporaryRecord]
      .filter((record): record is ObservableRoundRecord => record !== undefined);
    const removed = [...stateSnapshot.files, ...roundSnapshot.files];
    if (states.length === 0 && journals.length === 0) {
      if (removed.length > 0) {
        await store.clear(sessionId);
        await roundStore.clear(sessionId);
      }
      return { sessionId, children: [], removed, nothingRecorded: true };
    }
    const activeJournal = journals.find(
      (journal) => !isTerminalRound(journal) || journal.cleanupPending === true,
    );
    if (activeJournal !== undefined) {
      throw new WuxReviewError(
        `--end-session: observable round ${sessionId} is ${activeJournal.state}; run \`wux-review reconcile ${sessionId}\` first`,
      );
    }

    const reports: EndSessionChildReport[] = [];
    for (const candidate of recordedNames(sessionId, states, journals)) {
      try {
        validateRecordedName(sessionId, observablePrefix, candidate);
      } catch (error) {
        reports.push({ name: candidate.name, status: `failed: refused ${errorDetail(error)}` });
        continue;
      }
      try {
        const result = await run(["wux", "--local", "stop", candidate.name, "--yes"]);
        if (result.code === 0) {
          reports.push({ name: candidate.name, status: "stopped" });
        } else if (isAlreadyGone(result, candidate.legacy)) {
          reports.push({ name: candidate.name, status: "already-gone" });
        } else {
          reports.push({ name: candidate.name, status: `failed: ${stopFailure(result)}` });
        }
      } catch (error) {
        reports.push({ name: candidate.name, status: `failed: ${errorDetail(error)}` });
      }
    }
    const failures = reports.filter((report) => report.status.startsWith("failed:"));
    if (failures.length > 0) {
      throw new EndSessionFailure(
        `--end-session: cleanup failed; ${reports.map((report) => `${report.name}: ${report.status}`).join("; ")}`,
        { sessionId, children: reports, removed: [] },
      );
    }

    // Clear only after every exact recorded child is known stopped or absent.
    // Store clear methods include their matching .tmp files.
    await store.clear(sessionId);
    await roundStore.clear(sessionId);
    return {
      sessionId,
      children: reports,
      removed,
    };
  } finally {
    await releaseLock();
  }
}

function recordedNames(
  sessionId: string,
  states: SessionState[],
  journals: ObservableRoundRecord[],
): RecordedName[] {
  const names = new Map<string, RecordedName>();
  const add = (name: string, context: RecordedNameContext = {}) => {
    const existing = names.get(name);
    if (existing === undefined) {
      names.set(name, { name, legacy: context.legacy === true, contexts: [context] });
    } else {
      existing.legacy ||= context.legacy === true;
      existing.contexts.push(context);
    }
  };
  for (const state of states) {
    for (const round of state.children ?? []) {
      for (const child of round.claude) {
        add(child.childName, { reviewer: "claude", attempt: child.attempt });
      }
      for (const child of round.codex) {
        add(child.childName, { reviewer: "codex", attempt: child.attempt });
      }
    }
  }
  for (const journal of journals) {
    add(journal.expected.claudeChildName, { reviewer: "claude" });
    add(journal.expected.codexChildName, { reviewer: "codex" });
    for (const child of journal.prepared?.claude ?? []) add(child, { reviewer: "claude" });
    for (const child of journal.prepared?.codex ?? []) add(child, { reviewer: "codex" });
  }
  if (states.some(ranDirectHeadlessRound)) {
    add(sessionName(sessionId, "claude"), { legacy: true });
    add(sessionName(sessionId, "codex"), { legacy: true });
  }
  return [...names.values()];
}

interface RecordedNameContext {
  reviewer?: ReviewerName;
  attempt?: number;
  legacy?: boolean;
}

interface RecordedName {
  name: string;
  legacy: boolean;
  contexts: RecordedNameContext[];
}

function ranDirectHeadlessRound(state: SessionState): boolean {
  const observableRounds = new Set((state.children ?? []).map((round) => round.round));
  for (let round = 1; round <= (state.round ?? 0); round++) {
    if (!observableRounds.has(round)) return true;
  }
  return false;
}

function validateRecordedName(
  sessionId: string,
  observablePrefix: string,
  candidate: RecordedName,
): void {
  if (
    candidate.legacy
    && (candidate.name === sessionName(sessionId, "claude") || candidate.name === sessionName(sessionId, "codex"))
  ) return;
  const parsed = validateObservableChildName(observablePrefix, sessionId, candidate.name);
  for (const context of candidate.contexts) {
    if (context.reviewer !== undefined && parsed.reviewer !== context.reviewer) {
      throw new WuxReviewError(`reviewer does not match recorded ${context.reviewer} child`);
    }
    if (context.attempt !== undefined && parsed.attempt !== context.attempt) {
      throw new WuxReviewError(`attempt does not match recorded attempt ${context.attempt}`);
    }
  }
}

function isTerminalRound(record: ObservableRoundRecord): boolean {
  return ["completed", "failed", "timed_out", "tainted", "reconciled"].includes(record.state);
}

function stopFailure(result: RunResult): string {
  return result.stderr.trim() || result.stdout.trim() || `exit ${result.code}`;
}

// Keep cleanup's definition of a vanished child aligned with the observable
// backend's exact-child cleanup behavior.
const LEGACY_ALREADY_GONE_PATTERNS = [
  /^tmux session is not running(?:\s|$)/i,
  /^no such session(?:\s|$)/i,
  /^unknown session(?:\s|$)/i,
];

export function isAlreadyGone(result: RunResult, legacy = false): boolean {
  const patterns = legacy
    ? [...WUX_ALREADY_GONE_PATTERNS, ...LEGACY_ALREADY_GONE_PATTERNS]
    : WUX_ALREADY_GONE_PATTERNS;
  return [result.stdout, result.stderr]
    .map((message) => message.trim().replace(/^wux:\s*/i, ""))
    .some((message) => patterns.some((pattern) => pattern.test(message)));
}
