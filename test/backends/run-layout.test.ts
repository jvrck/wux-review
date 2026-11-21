import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { chmod, lstat, mkdir, mkdtemp, readdir, rename, rm, stat, symlink, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createRunDirectory,
  ensureRunsRoot,
  readRunJson,
  removeOwnedDir,
  runsTrashRoot,
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

    await writeFile(record, JSON.stringify({
      v: 1,
      kind: "codex",
      createdMs: 1_700_000_000_000,
      deadlineMs: 1,
      legMaxMs: 900_000,
    }));
    expect(await readRunJson(run.path)).toBeUndefined();
  });

  test("T-runjson-fifo: the bounded reader does not block on a FIFO", async () => {
    const stateDir = await stateRoot();
    const run = await createRunDirectory({
      stateDir,
      kind: "claude",
      createdMs: 1_700_000_000_000,
      deadlineMs: 1_700_000_900_000,
      legMaxMs: 900_000,
    });
    const record = join(run.path, "run.json");
    await rm(record);
    expect(await Bun.spawn(["/usr/bin/mkfifo", record]).exited).toBe(0);

    const result = await Promise.race([
      readRunJson(run.path),
      new Promise<"timeout">((resolve) => setTimeout(() => resolve("timeout"), 500)),
    ]);
    expect(result).toBeUndefined();
  });

  test("T-root-symlink / T-root-mode-0755: unsafe roots fail closed and owned roots are private", async () => {
    const stateDir = await stateRoot();
    const target = await mkdtemp(join(tmpdir(), "wuxr-run-target-"));
    roots.push(target);
    await symlink(target, join(stateDir, "wux-review"));
    await expect(createRunDirectory({
      stateDir,
      kind: "claude",
      createdMs: 1_700_000_000_000,
      deadlineMs: 1_700_000_900_000,
      legMaxMs: 900_000,
    })).rejects.toThrow();

    const modeState = await stateRoot();
    const appRoot = join(modeState, "wux-review");
    await mkdir(appRoot);
    await chmod(appRoot, 0o755);
    await ensureRunsRoot({ stateDir: modeState });
    expect((await stat(appRoot)).mode & 0o777).toBe(0o700);
  });

  test("T-root-wrong-uid: an owned-root check fails closed for another uid", async () => {
    const stateDir = await stateRoot();
    const uid = process.getuid?.();
    if (uid === undefined) return;
    const getuid = spyOn(process, "getuid").mockReturnValue(uid + 1);
    try {
      await expect(ensureRunsRoot({ stateDir })).rejects.toThrow();
    } finally {
      getuid.mockRestore();
    }
  });

  test("T-root-foreign-entries: foreign entries stay untouched and warn once per pass", async () => {
    const stateDir = await stateRoot();
    const root = await ensureRunsRoot({ stateDir });
    const file = join(root, "foreign-file");
    const fifo = join(root, "foreign-fifo");
    const socket = join(root, "foreign.sock");
    const target = join(stateDir, "symlink-target");
    const link = join(root, "foreign-link");
    const wuxrDirectory = join(root, "wuxr-foreign");
    const malformedRun = join(root, "r-bad");
    await writeFile(file, "foreign");
    expect(await Bun.spawn(["/usr/bin/mkfifo", fifo]).exited).toBe(0);
    await writeFile(target, "target");
    await symlink(target, link);
    await mkdir(wuxrDirectory);
    await mkdir(malformedRun);
    const server = createServer();
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(socket, () => {
        server.off("error", reject);
        resolve();
      });
    });
    const write = spyOn(process.stderr, "write").mockImplementation(() => true);
    try {
      await ensureRunsRoot({ stateDir });
      expect((await lstat(file)).isFile()).toBe(true);
      expect((await lstat(fifo)).isFIFO()).toBe(true);
      expect((await lstat(socket)).isSocket()).toBe(true);
      expect((await lstat(link)).isSymbolicLink()).toBe(true);
      expect(await Bun.file(target).text()).toBe("target");
      expect((await lstat(wuxrDirectory)).isDirectory()).toBe(true);
      expect((await lstat(malformedRun)).isDirectory()).toBe(true);
      expect(write).toHaveBeenCalledTimes(1);
      await ensureRunsRoot({ stateDir });
      expect(write).toHaveBeenCalledTimes(2);
    } finally {
      write.mockRestore();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  test("T-L2-journal-accept and T-L2-reject-table: only exact owned cleanup shapes pass", async () => {
    const stateDir = await stateRoot();
    const runs = join(stateDir, "wux-review", "runs");
    const l1 = join(stateDir, "wux-review", "codex-homes", "wuxr-codex-home-AbC123");
    const l1Cwd = join(l1, "wuxr-reviewer-cwd-DeF456");
    const l2 = join(tmpdir(), "wuxr-reviewer-cwd-GhI789");
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

  test("T-marker-named-dir: an unshipped marker-shaped L1 directory is retained", async () => {
    const stateDir = await stateRoot();
    const homes = join(stateDir, "wux-review", "codex-homes");
    const home = join(homes, "wuxr-codex-home-AbC123");
    const marker = `${home}.wuxr-last-use`;
    await mkdir(homes, { recursive: true });
    await mkdir(home);
    await mkdir(marker);

    expect(validateCleanupDirectory(marker, { stateDir, tempDir: tmpdir() })).toBe(false);
    await removeOwnedDir(marker, { stateDir, tempDir: tmpdir() });
    expect((await stat(marker)).isDirectory()).toBe(true);

    await removeOwnedDir(home, { stateDir, tempDir: tmpdir() });
    expect(await Bun.file(home).exists()).toBe(false);
  });

  test("T-legacy-near-misses: L1/L2 cleanup accepts only exact generated names", () => {
    const stateDir = "/state";
    const homes = join(stateDir, "wux-review", "codex-homes");
    const l1 = join(homes, "wuxr-codex-home-AbC123");
    const l2 = join(tmpdir(), "wuxr-reviewer-cwd-DeF456");
    for (const path of [
      join(homes, "wuxr-codex-home-AbC123-extra"),
      `${l1}.wuxr-last-use`,
      `${l1}/`,
      join(homes, "wuxr-codex-home-AbC123", "nested"),
      join(tmpdir(), "wuxr-reviewer-cwd-DeF456-extra"),
      `${l2}/`,
      join(tmpdir(), "wuxr-codex-home-AbC123"),
      `${homes}/../codex-homes/wuxr-codex-home-AbC123`,
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

  test("T-swap-to-symlink-before-rename: a hook swaps the entry after lstat and before rename", async () => {
    const stateDir = await stateRoot();
    const run = await createRunDirectory({
      stateDir,
      kind: "claude",
      createdMs: 1_700_000_000_000,
      deadlineMs: 1_700_000_900_000,
      legMaxMs: 900_000,
    });
    const outside = join(stateDir, "outside-directory");
    await mkdir(outside);
    await removeOwnedDir(run.path, {
      stateDir,
      tempDir: tmpdir(),
      beforeRename: async (path) => {
        await rm(path, { recursive: true });
        await symlink(outside, path);
      },
    });

    expect(await Bun.file(run.path).exists()).toBe(false);
    expect((await stat(outside)).isDirectory()).toBe(true);
  });

  test("T-swap-to-directory-before-rename: a replaced directory is never recursively deleted", async () => {
    const stateDir = await stateRoot();
    const run = await createRunDirectory({
      stateDir,
      kind: "claude",
      createdMs: 1_700_000_000_000,
      deadlineMs: 1_700_000_900_000,
      legMaxMs: 900_000,
    });
    const victim = join(stateDir, "victim");
    await mkdir(victim);
    await writeFile(join(victim, "keep"), "keep");

    await removeOwnedDir(run.path, {
      stateDir,
      tempDir: tmpdir(),
      beforeRename: async (path) => {
        await rm(path, { recursive: true });
        await rename(victim, path);
      },
    });

    const retained = await readdir(runsTrashRoot({ stateDir, tempDir: tmpdir() }));
    expect(retained).toHaveLength(1);
    const retainedVictim = join(runsTrashRoot({ stateDir, tempDir: tmpdir() }), retained[0]!);
    expect(await Bun.file(join(retainedVictim, "keep")).exists()).toBe(true);
    expect((await lstat(retainedVictim)).isDirectory()).toBe(true);
  });

  test("T-run-wrong-uid: a run belonging to another uid is kept", async () => {
    const stateDir = await stateRoot();
    const run = await createRunDirectory({
      stateDir,
      kind: "claude",
      createdMs: 1_700_000_000_000,
      deadlineMs: 1_700_000_900_000,
      legMaxMs: 900_000,
    });
    const uid = process.getuid?.();
    if (uid === undefined) return;
    const getuid = spyOn(process, "getuid").mockReturnValue(uid + 1);
    try {
      await removeOwnedDir(run.path, { stateDir, tempDir: tmpdir() });
      expect((await stat(run.path)).isDirectory()).toBe(true);
    } finally {
      getuid.mockRestore();
    }
  });

  test("T-fifo-inside-run: recursive removal unlinks a FIFO without opening it", async () => {
    const stateDir = await stateRoot();
    const run = await createRunDirectory({
      stateDir,
      kind: "claude",
      createdMs: 1_700_000_000_000,
      deadlineMs: 1_700_000_900_000,
      legMaxMs: 900_000,
    });
    const fifo = join(run.cwd, "fifo");
    expect(await Bun.spawn(["/usr/bin/mkfifo", fifo]).exited).toBe(0);

    await removeOwnedDir(run.path, { stateDir, tempDir: tmpdir() });

    expect(await Bun.file(run.path).exists()).toBe(false);
  });

  test("T-single-recursive-remover: only the owned remover contains recursive filesystem deletion", async () => {
    const files = await productionTypeScriptFiles(
      new URL("../../src/", import.meta.url),
    );
    const recursiveFiles: string[] = [];
    const wrapperFiles: string[] = [];
    for (const file of files) {
      const source = await Bun.file(file).text();
      if (/rm\([^\n]*recursive:\s*true|rmSync\(|rmdir\([^\n]*recursive:\s*true/.test(source)) {
        recursiveFiles.push(file.pathname);
      }
      if (/rm -rf/.test(source)) wrapperFiles.push(file.pathname);
    }
    expect(recursiveFiles).toEqual([new URL("../../src/backends/run-layout.ts", import.meta.url).pathname]);
    expect(wrapperFiles).toEqual([new URL("../../src/backends/observable.ts", import.meta.url).pathname]);
  });
});

async function productionTypeScriptFiles(directory: URL): Promise<URL[]> {
  const files: URL[] = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = new URL(entry.name, directory);
    if (entry.isDirectory()) files.push(...await productionTypeScriptFiles(new URL(`${entry.name}/`, directory)));
    else if (entry.isFile() && entry.name.endsWith(".ts")) files.push(path);
  }
  return files.sort((a, b) => a.pathname.localeCompare(b.pathname));
}
