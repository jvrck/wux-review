import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = fileURLToPath(new URL("..", import.meta.url));
const GUARD = join(REPO_ROOT, "scripts", "check-tracked-large-files.sh");
const ALLOWLIST = "scripts/tracked-large-files.allowlist";

function runGit(root: string, args: string[]): void {
  const result = Bun.spawnSync(["git", ...args], { cwd: root, stderr: "pipe" });
  if (result.exitCode !== 0) throw new Error(result.stderr.toString());
}

function makeRepo(): string {
  const root = mkdtempSync(join(tmpdir(), "wuxr-large-files-"));
  runGit(root, ["init", "-q"]);
  writeFile(root, ALLOWLIST, "# intentional exceptions\n\n");
  return root;
}

function writeFile(root: string, path: string, content: string | Uint8Array): void {
  mkdirSync(dirname(join(root, path)), { recursive: true });
  writeFileSync(join(root, path), content);
}

function track(root: string, path: string): void {
  runGit(root, ["add", "--", path]);
}

function runGuard(root: string) {
  return Bun.spawnSync(["bash", GUARD], { cwd: root, stdout: "pipe", stderr: "pipe" });
}

describe("tracked large-file guard", () => {
  test("passes small tracked files", () => {
    const root = makeRepo();
    try {
      writeFile(root, "small.txt", "small\n");
      track(root, ALLOWLIST);
      track(root, "small.txt");

      const result = runGuard(root);
      expect(result.exitCode).toBe(0);
      expect(result.stdout.toString()).toContain("pass");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("fails an oversized tracked blob even when its worktree file is absent", () => {
    const root = makeRepo();
    try {
      writeFile(root, "large.bin", new Uint8Array(1048577));
      track(root, ALLOWLIST);
      track(root, "large.bin");
      rmSync(join(root, "large.bin"));

      const result = runGuard(root);
      expect(result.exitCode).toBe(1);
      expect(result.stderr.toString()).toContain("large.bin (1048577 bytes)");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("permits a reviewed exact-path allowlist entry", () => {
    const root = makeRepo();
    try {
      writeFile(root, "large.bin", new Uint8Array(1048577));
      writeFile(root, ALLOWLIST, "# intentional exceptions\n\nlarge.bin\n");
      track(root, ALLOWLIST);
      track(root, "large.bin");

      const result = runGuard(root);
      expect(result.exitCode).toBe(0);
      expect(result.stdout.toString()).toContain("pass");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("does not accept an unstaged allowlist exception", () => {
    const root = makeRepo();
    try {
      writeFile(root, "large.bin", new Uint8Array(1048577));
      track(root, ALLOWLIST);
      track(root, "large.bin");
      writeFile(root, ALLOWLIST, "large.bin\n");

      const result = runGuard(root);
      expect(result.exitCode).toBe(1);
      expect(result.stderr.toString()).toContain("large.bin (1048577 bytes)");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("rejects a NUL-containing allowlist entry instead of truncating it", () => {
    const root = makeRepo();
    try {
      writeFile(root, "large", new Uint8Array(1048577));
      writeFile(root, ALLOWLIST, new Uint8Array([108, 97, 114, 103, 101, 0, 106, 117, 110, 107, 10]));
      track(root, ALLOWLIST);
      track(root, "large");

      const result = runGuard(root);
      expect(result.exitCode).toBe(1);
      expect(result.stderr.toString()).toContain("NUL byte on line 1");
      expect(result.stdout.toString()).not.toContain("pass");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("does not treat a comment as an allowlist entry", () => {
    const root = makeRepo();
    try {
      writeFile(root, "#large.bin", new Uint8Array(1048577));
      writeFile(root, ALLOWLIST, "#large.bin\n");
      track(root, ALLOWLIST);
      track(root, "#large.bin");

      const result = runGuard(root);
      expect(result.exitCode).toBe(1);
      expect(result.stderr.toString()).toContain("#large.bin (1048577 bytes)");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("skips a gitlink whose commit is absent from the superproject", () => {
    const root = makeRepo();
    try {
      track(root, ALLOWLIST);
      runGit(root, ["update-index", "--add", "--cacheinfo", "160000,0123456789012345678901234567890123456789,vendor/submodule"]);

      const result = runGuard(root);
      expect(result.exitCode).toBe(0);
      expect(result.stdout.toString()).toContain("pass");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("fails instead of passing when the index contains no tracked files", () => {
    const root = makeRepo();
    try {
      const result = runGuard(root);
      expect(result.exitCode).toBe(1);
      expect(result.stderr.toString()).toContain("zero tracked files");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("fails outside a Git worktree", () => {
    const root = mkdtempSync(join(tmpdir(), "wuxr-large-files-no-repo-"));
    try {
      const result = runGuard(root);
      expect(result.exitCode).toBe(1);
      expect(result.stderr.toString()).toContain("must run inside a Git worktree");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
