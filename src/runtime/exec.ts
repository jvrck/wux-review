// Thin wrapper around process spawning so the rest of the code depends on a
// small, mockable surface rather than Bun.spawn directly.
export interface RunResult {
  code: number;
  stdout: string;
  stderr: string;
}

export type Run = (cmd: string[]) => Promise<RunResult>;

export const run: Run = async (cmd: string[]): Promise<RunResult> => {
  const proc = Bun.spawn(cmd, { stdout: "pipe", stderr: "pipe" });
  const [stdout, stderr, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  return { code, stdout, stderr };
};
