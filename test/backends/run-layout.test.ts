import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createRunDirectory,
  readRunJson,
  removeOwnedDir,
  validateCleanupDirectory,
} from "../../src/backends/run-layout";

const roots: string[] = [];

async function stateRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "wuxr-runs-test-"));
  roots.push(root);
  return root;
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

describe("PR1 run layout", () => {
  test("T-runjson-present: creates a private per-leg run with a parent-written record", async () => {
    const stateDir = await stateRoot();
    const run = await createRunDirectory({
      stateDir,
      kind: "claude",
      createdMs: 1_700_000_000_000,
      deadlineMs: 1_700_000_900_000,
      legMaxMs: 900_000,
    });

    expect(run.path).toMatch(/\/wux-review\/runs\/r-[0-9a-z]{1,11}-[A-Za-z0-9]{6}$/);
    expect(run.cwd).toBe(join(run.path, "cwd"));
    expect(await readRunJson(run.path)).toEqual({
      v: 1,
      kind: "claude",
      createdMs: 1_700_000_000_000,
      deadlineMs: 1_700_000_900_000,
      legMaxMs: 900_000,
    });
  });

  test("T-runjson-symlink / -huge / -garbage: unreadable records never parse", async () => {
    const stateDir = await stateRoot();
    const run = await createRunDirectory({
      stateDir,
      kind: "codex",
      createdMs: 1_700_000_000_000,
      deadlineMs: 1_700_000_900_000,
      legMaxMs: 900_000,
    });
    const record = join(run.path, "run.json");
    const target = join(stateDir, "target.json");

    await writeFile(target, "{}");
    await rm(record);
    await symlink(target, record);
    expect(await readRunJson(run.path)).toBeUndefined();

    await rm(record);
    await writeFile(record, "x".repeat(4097));
    expect(await readRunJson(run.path)).toBeUndefined();

    await writeFile(record, "not json");
    expect(await readRunJson(run.path)).toBeUndefined();
  });

  test("T-L2-journal-accept and T-L2-reject-table: only exact owned cleanup shapes pass", async () => {
    const stateDir = await stateRoot();
    const runs = join(stateDir, "wux-review", "runs");
    const l1 = join(stateDir, "wux-review", "codex-homes", "wuxr-codex-home-old");
    const l1Cwd = join(l1, "wuxr-reviewer-cwd-old");
    const l2 = join(tmpdir(), "wuxr-reviewer-cwd-old");
    const run = join(runs, "r-kf12oi-ABC123");

    for (const path of [run, l1, l1Cwd, l2]) {
      expect(validateCleanupDirectory(path, { stateDir, tempDir: tmpdir() })).toBe(true);
    }
    for (const path of [
      join(l1, "nested"),
      join(tmpdir(), "nested", "wuxr-reviewer-cwd-old"),
      join(tmpdir(), "wuxr-codex-home-old"),
      join(runs, "r-not-a-run"),
      `${l2}/`,
    ]) {
      expect(validateCleanupDirectory(path, { stateDir, tempDir: tmpdir() })).toBe(false);
    }
  });

  test("T-symlink-inside-run: removal unlinks links without touching their target", async () => {
    const stateDir = await stateRoot();
    const outside = join(stateDir, "outside");
    const run = await createRunDirectory({
      stateDir,
      kind: "claude",
      createdMs: 1_700_000_000_000,
      deadlineMs: 1_700_000_900_000,
      legMaxMs: 900_000,
    });
    await writeFile(outside, "keep");
    await symlink(outside, join(run.cwd, "outside-link"));

    await removeOwnedDir(run.path, { stateDir, tempDir: tmpdir() });

    expect(await Bun.file(run.path).exists()).toBe(false);
    expect(await Bun.file(outside).text()).toBe("keep");
  });
});
