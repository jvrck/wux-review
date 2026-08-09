import type { WuxReviewConfig } from "./config";

// The deterministic check is a *mechanic* with a config-driven command, kept
// separate from the AI review: `wux-review check` runs it and exits with its
// status, so a repo's build/test gate stays portable (Bun by default, but a
// non-Bun repo points `check:` in .wux-review.yml at pytest/cargo/etc.). The
// review verdict is unchanged — it still blocks iff a reviewer raises a must-fix.
export const DEFAULT_CHECK = ["bun run typecheck && bun test"];

// The active check commands: the configured list, else the Bun default.
export function resolveCheck(config: WuxReviewConfig): string[] {
  return config.check ?? DEFAULT_CHECK;
}

// Runs one shell command and resolves its exit code. The default inherits stdio
// so the user sees the check output live; tests inject a mock.
export type RunCommand = (command: string) => Promise<number>;

const defaultRunCommand: RunCommand = async (command) => {
  const proc = Bun.spawn(["bash", "-c", command], {
    stdout: "inherit",
    stderr: "inherit",
    stdin: "inherit",
  });
  return proc.exited;
};

// Run the check commands in order, stopping at the first failure and returning
// its exit code (0 if every command passes). Fail-fast mirrors `cmd1 && cmd2`.
export async function runCheck(commands: string[], runCommand: RunCommand = defaultRunCommand): Promise<number> {
  for (const command of commands) {
    const code = await runCommand(command);
    if (code !== 0) {
      return code;
    }
  }
  return 0;
}
