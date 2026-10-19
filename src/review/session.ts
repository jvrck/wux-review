import { WUX_ALREADY_GONE_PATTERNS } from "../backends/observable";
import { run as defaultRun, type Run, type RunResult } from "../runtime/exec";
import { WuxReviewError } from "../runtime/errors";
import {
  acquireObservableRecoveryLock,
  defaultObservableRoundStore,
  type ObservableRoundRecord,
  type ObservableRoundStore,
} from "./observable-lifecycle";
import { sessionName, validateObservableChildName, validateSessionId } from "./reviewers";
import { defaultSessionStore, type SessionStore } from "./session-state";
import type { SessionState } from "./types";

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
  const releaseLock = await (deps.acquireLock ?? acquireObservableRecoveryLock)(sessionId);
  try {
    const stateSnapshot = store.inspectForEndSession === undefined
      ? { state: await store.load(sessionId), files: [] }
      : await store.inspectForEndSession(sessionId);
    const roundSnapshot = roundStore.inspectForEndSession === undefined
      ? { record: await roundStore.load(sessionId), files: [] }
      : await roundStore.inspectForEndSession(sessionId);
    const state = stateSnapshot.state;
    const journal = roundSnapshot.record;
    if (state === undefined && journal === undefined) {
      return { sessionId, children: [], removed: [], nothingRecorded: true };
    }
    if (journal !== undefined && (!isTerminalRound(journal) || journal.cleanupPending === true)) {
      throw new WuxReviewError(
        `--end-session: observable round ${sessionId} is ${journal.state}; run \`wux-review reconcile ${sessionId}\` first`,
      );
    }

    const reports: EndSessionChildReport[] = [];
    for (const { name, legacy } of recordedNames(sessionId, state, journal)) {
      try {
        validateRecordedName(sessionId, name, legacy);
      } catch (error) {
        reports.push({ name, status: `failed: refused ${(error as Error).message}` });
        continue;
      }
      try {
        const result = await run(["wux", "--local", "stop", name, "--yes"]);
        if (result.code === 0) {
          reports.push({ name, status: "stopped" });
        } else if (isAlreadyGone(result)) {
          reports.push({ name, status: "already-gone" });
        } else {
          reports.push({ name, status: `failed: ${stopFailure(result)}` });
        }
      } catch (error) {
        reports.push({ name, status: `failed: ${(error as Error).message}` });
      }
    }
    const failures = reports.filter((report) => report.status.startsWith("failed:"));
    if (failures.length > 0) {
      throw new WuxReviewError(
        `--end-session: cleanup failed; ${reports.map((report) => `${report.name}: ${report.status}`).join("; ")}`,
      );
    }

    // Clear only after every exact recorded child is known stopped or absent.
    // Store clear methods include their matching .tmp files.
    await store.clear(sessionId);
    await roundStore.clear(sessionId);
    return {
      sessionId,
      children: reports,
      removed: [...stateSnapshot.files, ...roundSnapshot.files],
    };
  } finally {
    await releaseLock();
  }
}

function recordedNames(
  sessionId: string,
  state: SessionState | undefined,
  journal: ObservableRoundRecord | undefined,
): Array<{ name: string; legacy: boolean }> {
  const names = new Map<string, boolean>();
  const add = (name: string, legacy = false) => {
    names.set(name, names.get(name) === true || legacy);
  };
  for (const round of state?.children ?? []) {
    for (const child of [...round.claude, ...round.codex]) add(child.childName);
  }
  if (journal !== undefined) {
    add(journal.expected.claudeChildName);
    add(journal.expected.codexChildName);
    for (const child of journal.prepared?.claude ?? []) add(child);
    for (const child of journal.prepared?.codex ?? []) add(child);
  }
  if (state !== undefined && ranDirectHeadlessRound(state)) {
    add(sessionName(sessionId, "claude"), true);
    add(sessionName(sessionId, "codex"), true);
  }
  return [...names].map(([name, legacy]) => ({ name, legacy }));
}

function ranDirectHeadlessRound(state: SessionState): boolean {
  const observableRounds = new Set((state.children ?? []).map((round) => round.round));
  for (let round = 1; round <= (state.round ?? 0); round++) {
    if (!observableRounds.has(round)) return true;
  }
  return false;
}

function validateRecordedName(sessionId: string, name: string, legacy: boolean): void {
  if (legacy && (name === sessionName(sessionId, "claude") || name === sessionName(sessionId, "codex"))) return;
  validateObservableChildName(sessionId, name);
}

function isTerminalRound(record: ObservableRoundRecord): boolean {
  return ["completed", "failed", "timed_out", "tainted", "reconciled"].includes(record.state);
}

function stopFailure(result: RunResult): string {
  return result.stderr.trim() || result.stdout.trim() || `exit ${result.code}`;
}

// Keep cleanup's definition of a vanished child aligned with the observable
// backend's exact-child cleanup behavior.
export function isAlreadyGone(result: RunResult): boolean {
  return [result.stdout, result.stderr]
    .map((message) => message.trim().replace(/^wux:\s*/i, ""))
    .some((message) => WUX_ALREADY_GONE_PATTERNS.some((pattern) => pattern.test(message)));
}
