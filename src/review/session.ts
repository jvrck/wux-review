import { run as defaultRun, type Run, type RunResult } from "../runtime/exec";
import { WuxReviewError } from "../runtime/errors";
import { sessionName, validateSessionId } from "./reviewers";
import { defaultSessionStore, type SessionStore } from "./session-state";

// Explicit cleanup for `--session`: tear down both reviewer sessions for a
// session id. Session mode deliberately leaves them running between re-reviews
// (inspectable, attachable, context retained); this is how a caller ends them
// once the fix loop has converged.
//
// This is the only sanctioned cleanup path, so a genuine stop failure must be
// surfaced (not silently reported as success). A session that is already gone is
// the desired end state, so that benign case is treated as success. Both
// sessions are attempted even if the first fails.
export async function endSession(
  sessionId: string,
  run: Run = defaultRun,
  store: SessionStore = defaultSessionStore,
): Promise<void> {
  validateSessionId(sessionId);
  // Clear the persisted per-session prior-findings state (#91) first. Best-effort:
  // a clear failure must not mask a genuine session-stop failure below, and a
  // leftover state file in the temp root is harmless (it is only read back under
  // the same `--session <id>`).
  await store.clear(sessionId).catch(() => undefined);
  const failures: string[] = [];
  for (const reviewer of ["claude", "codex"] as const) {
    const name = sessionName(sessionId, reviewer);
    try {
      const result = await run(["wux", "--local", "stop", name, "--yes"]);
      if (result.code !== 0 && !isAlreadyGone(result)) {
        failures.push(`${name}: ${result.stderr.trim() || `exit ${result.code}`}`);
      }
    } catch (err) {
      // A rejected run() (e.g. spawn-level failure) must not abort the loop —
      // both sessions are always attempted.
      failures.push(`${name}: ${(err as Error).message}`);
    }
  }
  if (failures.length > 0) {
    throw new WuxReviewError(`--end-session: failed to stop ${failures.join("; ")}`);
  }
}

// A stop that fails only because the session isn't there is success — the goal
// is "not running". Patterns are scoped to wux/tmux session wording so a real
// failure (e.g. "command not found", "no such file or directory") is NOT
// misclassified as benign.
function isAlreadyGone(result: RunResult): boolean {
  const message = `${result.stdout} ${result.stderr}`.toLowerCase();
  return /not running|no such session|unknown session/.test(message);
}
