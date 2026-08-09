import type { Reviewers } from "../review/reviewers";
import { createClaudeHeadlessBackend, createCodexHeadlessBackend } from "./headless";

export { createClaudeHeadlessBackend, createCodexHeadlessBackend, defaultHeadlessRun } from "./headless";
export type { HeadlessBackendDeps, HeadlessRun, HeadlessRunOptions, HeadlessRunResult } from "./headless";
export { buildObservableWrapperScript, runObservableLeg } from "./observable";
export type { ObservableAdapterDeps, ObservableLegInput, ObservableLegResult } from "./observable";

// The production reviewer pair: Claude and Codex, each driven as a bounded,
// one-shot **headless** subprocess (`claude -p --output-format stream-json` /
// `codex exec --json`). There is no interactive `wux run` TUI driving the
// verdict path — that send-into-a-TUI chokepoint was the unattended stall that
// produced empty, timed-out verdicts. The default observable transport runs
// each unchanged headless argv inside a fresh `wux run shell`
// session and returns only its validated atomic result (see observable.ts); it
// never pastes into a TUI.
export function defaultBackends(): Reviewers {
  return {
    claude: createClaudeHeadlessBackend(),
    codex: createCodexHeadlessBackend(),
  };
}
