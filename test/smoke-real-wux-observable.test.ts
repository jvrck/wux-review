import { expect, test } from "bun:test";
import { chmodSync, cpSync, mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";

const REPO_ROOT = fileURLToPath(new URL("..", import.meta.url));
const smokeScript = join(REPO_ROOT, "scripts/smoke-real-wux-observable.sh");

function makeExecutable(path: string, contents: string): void {
  writeFileSync(path, contents);
  chmodSync(path, 0o755);
}

function run(command: string[], env: Record<string, string> = {}) {
  return Bun.spawnSync({
    cmd: command,
    cwd: REPO_ROOT,
    env: { ...process.env, ...env },
    stderr: "pipe",
    stdout: "pipe",
  });
}

test("real-Wux smoke parses as shell", () => {
  const result = run(["bash", "-n", smokeScript]);
  expect(result.exitCode).toBe(0);
});

test("real-Wux version drift explicitly skips with non-success status", () => {
  const root = mkdtempSync(join(tmpdir(), "wux-review smoke mismatch-"));
  const fakeWux = join(root, "wux");
  makeExecutable(fakeWux, "#!/usr/bin/env bash\nprintf '1.2.3\\n'\n");

  try {
    const result = run(["bash", smokeScript], {
      WUX_REVIEW_BIN: "/usr/bin/true",
      WUX_REAL_SMOKE_WUX_BIN: fakeWux,
      WUX_REAL_SMOKE_WUX_VERSION: "2026.08.17",
      WUX_REAL_SMOKE_ROOT: join(root, "root"),
    });
    expect(result.exitCode).toBe(77);
    expect(new TextDecoder().decode(result.stderr)).toContain(
      "SKIP: expected Wux 2026.08.17, got 1.2.3",
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test.if(Boolean(process.env.WUX_REAL_SMOKE_TEST_WUX_BIN))(
  "real-Wux status failures are retried and retained in the visibility timeout",
  () => {
    const root = mkdtempSync(join(tmpdir(), "wux-review status failure-"));
    const statusFailingWux = join(root, "wux");
    makeExecutable(
      statusFailingWux,
      [
        "#!/usr/bin/env bash",
        'if [ "$1" = "--local" ] && [ "$2" = "status" ] && [ "$3" = "--json" ]; then',
        "  printf 'deliberate status failure\\n' >&2",
        "  exit 42",
        "fi",
        'exec "${WUX_REAL_SMOKE_TEST_WUX_BIN:?}" "$@"',
        "",
      ].join("\n"),
    );

    try {
      const result = run(["bash", smokeScript], {
        WUX_REVIEW_BIN: process.env.WUX_REAL_SMOKE_TEST_REVIEW_BIN!,
        WUX_REAL_SMOKE_WUX_BIN: statusFailingWux,
        WUX_REAL_SMOKE_WUX_VERSION: "2026.08.17",
        WUX_REAL_SMOKE_ROOT: join(root, "root"),
      });
      expect(result.exitCode).toBe(1);
      expect(new TextDecoder().decode(result.stderr)).toContain(
        "last wux status failure: deliberate status failure",
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  },
  15_000,
);

test.if(process.env.WUXR_SPACE_PROOF !== "1")(
  "focused smoke tests run from a checkout path containing a space",
  () => {
    const parent = mkdtempSync(join(tmpdir(), "wux-review checkout-"));
    const copiedRoot = join(parent, "repo with space");
    mkdirSync(copiedRoot);
    cpSync(join(REPO_ROOT, "scripts"), join(copiedRoot, "scripts"), { recursive: true });
    mkdirSync(join(copiedRoot, "test"));
    cpSync(import.meta.filename, join(copiedRoot, "test", "smoke-real-wux-observable.test.ts"));

    try {
      const childEnv: Record<string, string | undefined> = {
        ...process.env,
        WUXR_SPACE_PROOF: "1",
      };
      delete childEnv.WUX_REAL_SMOKE_TEST_WUX_BIN;
      delete childEnv.WUX_REAL_SMOKE_TEST_REVIEW_BIN;
      const result = Bun.spawnSync({
        cmd: [process.execPath, "test", "test/smoke-real-wux-observable.test.ts"],
        cwd: copiedRoot,
        env: childEnv,
        stderr: "pipe",
        stdout: "pipe",
      });
      expect(result.exitCode).toBe(0);
    } finally {
      rmSync(parent, { recursive: true, force: true });
    }
  },
);
