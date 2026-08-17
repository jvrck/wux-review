import { expect, test } from "bun:test";
import {
  chmodSync,
  cpSync,
  existsSync,
  mkdtempSync,
  mkdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";

const REPO_ROOT = fileURLToPath(new URL("..", import.meta.url));
const smokeScript = join(REPO_ROOT, "scripts/smoke-real-wux-observable.sh");
const exactFixtureAvailable = Boolean(
  process.env.WUX_REAL_SMOKE_TEST_WUX_BIN && process.env.WUX_REAL_SMOKE_TEST_REVIEW_BIN,
);

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
  const commands = join(root, "commands");
  const fakeWux = join(root, "wux");
  mkdirSync(commands);
  for (const command of ["git", "jq", "tmux"])
    makeExecutable(join(commands, command), "#!/bin/sh\nexit 0\n");
  makeExecutable(fakeWux, "#!/usr/bin/env bash\nprintf '1.2.3\\n'\n");

  try {
    const result = run(["bash", smokeScript], {
      PATH: `${commands}:${process.env.PATH ?? ""}`,
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

test.if(exactFixtureAvailable)(
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

test.if(exactFixtureAvailable)(
  "real-Wux status JSON stays parseable when a successful call warns on stderr",
  () => {
    const root = mkdtempSync(join(tmpdir(), "wux-review status warning-"));
    const statusWarningWux = join(root, "wux");
    const warningMarker = join(root, "warning-status-ran");
    makeExecutable(
      statusWarningWux,
      [
        "#!/usr/bin/env bash",
        "set -uo pipefail",
        'if [ "$1" = "--local" ] && [ "$2" = "status" ] && [ "$3" = "--json" ]; then',
        '  "${WUX_REAL_SMOKE_TEST_WUX_BIN:?}" "$@"',
        '  status="$?"',
        '  : > "${WUXR_STATUS_WARNING_MARKER:?}"',
        "  printf 'deliberate status warning\\n' >&2",
        '  exit "$status"',
        "fi",
        'exec "${WUX_REAL_SMOKE_TEST_WUX_BIN:?}" "$@"',
        "",
      ].join("\n"),
    );

    try {
      const result = run(["bash", smokeScript], {
        WUX_REVIEW_BIN: process.env.WUX_REAL_SMOKE_TEST_REVIEW_BIN!,
        WUX_REAL_SMOKE_WUX_BIN: statusWarningWux,
        WUX_REAL_SMOKE_WUX_VERSION: "2026.08.17",
        WUX_REAL_SMOKE_ROOT: join(root, "root"),
        WUXR_STATUS_WARNING_MARKER: warningMarker,
      });
      expect(result.exitCode).toBe(0);
      expect(existsSync(warningMarker)).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  },
  90_000,
);

test.if(exactFixtureAvailable)(
  "a transient status failure followed by successes cannot cause a stale-failure timeout",
  () => {
    const root = mkdtempSync(join(tmpdir(), "wux-review recovered status-"));
    const recoveredWux = join(root, "wux");
    const failureMarker = join(root, "status-failed-once");
    makeExecutable(
      recoveredWux,
      [
        "#!/usr/bin/env bash",
        "set -euo pipefail",
        'if [ "$1" = "--local" ] && [ "$2" = "status" ] && [ "$3" = "--json" ]; then',
        '  if [ ! -e "${WUXR_STATUS_FAILURE_MARKER:?}" ]; then',
        '    : > "$WUXR_STATUS_FAILURE_MARKER"',
        "    printf 'deliberate transient status failure\\n' >&2",
        "    exit 42",
        "  fi",
        "  printf '[]\\n'",
        "  exit 0",
        "fi",
        'exec "${WUX_REAL_SMOKE_TEST_WUX_BIN:?}" "$@"',
        "",
      ].join("\n"),
    );

    try {
      const result = run(["bash", smokeScript], {
        WUX_REVIEW_BIN: process.env.WUX_REAL_SMOKE_TEST_REVIEW_BIN!,
        WUX_REAL_SMOKE_WUX_BIN: recoveredWux,
        WUX_REAL_SMOKE_WUX_VERSION: "2026.08.17",
        WUX_REAL_SMOKE_ROOT: join(root, "root"),
        WUXR_STATUS_FAILURE_MARKER: failureMarker,
      });
      const stderr = new TextDecoder().decode(result.stderr);
      expect(existsSync(failureMarker)).toBe(true);
      expect(result.exitCode).toBe(1);
      expect(stderr).toContain("did not expose both reviewer sessions within five seconds");
      expect(stderr).not.toContain("last wux status failure");
      expect(stderr).not.toContain("deliberate transient status failure");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  },
  15_000,
);

if (process.env.WUXR_SPACE_PROOF !== "1") {
  test.if(exactFixtureAvailable)(
    "focused smoke tests run from a checkout path containing a space without relevant skips",
    () => {
      const parent = mkdtempSync(join(tmpdir(), "wux-review checkout-"));
      const copiedRoot = join(parent, "repo with space");
      mkdirSync(copiedRoot);
      cpSync(join(REPO_ROOT, "scripts"), join(copiedRoot, "scripts"), { recursive: true });
      mkdirSync(join(copiedRoot, "test"));
      cpSync(import.meta.filename, join(copiedRoot, "test", "smoke-real-wux-observable.test.ts"));

      try {
        const result = Bun.spawnSync({
          cmd: [process.execPath, "test", "test/smoke-real-wux-observable.test.ts"],
          cwd: copiedRoot,
          env: { ...process.env, WUXR_SPACE_PROOF: "1" },
          stderr: "pipe",
          stdout: "pipe",
        });
        const output = `${new TextDecoder().decode(result.stdout)}\n${new TextDecoder().decode(result.stderr)}`;
        expect(result.exitCode).toBe(0);
        expect(output).toContain("5 pass");
        expect(output).not.toMatch(/\n\s*\d+ skip\b/);
      } finally {
        rmSync(parent, { recursive: true, force: true });
      }
    },
    180_000,
  );
}
