import { constants as fsConstants } from "node:fs";
import { chmod, lstat, mkdir, mkdtemp, open, readdir, rename, rm, unlink } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";

const RUN_NAME = /^r-[0-9a-z]{1,11}-[A-Za-z0-9]{6}$/;
const RUN_JSON_LIMIT_BYTES = 4 * 1024;

export interface RunJson {
  v: 1;
  kind: "claude" | "codex";
  createdMs: number;
  deadlineMs: number;
  legMaxMs: number;
}

export interface CreateRunDirectoryOptions {
  stateDir?: string;
  kind: RunJson["kind"];
  createdMs: number;
  deadlineMs: number;
  legMaxMs: number;
}

export interface RunDirectory {
  path: string;
  cwd: string;
  home?: string;
  cleanup: () => Promise<void>;
}

export interface CleanupPathOptions {
  stateDir?: string;
  tempDir?: string;
}

function configuredStateDir(stateDir?: string): string {
  if (stateDir !== undefined) return resolve(stateDir);
  const xdg = process.env.XDG_STATE_HOME;
  return xdg !== undefined && xdg !== "" && isAbsolute(xdg)
    ? resolve(xdg)
    : join(homedir(), ".local", "state");
}

export function reviewStateRoot(options: CleanupPathOptions = {}): string {
  return join(configuredStateDir(options.stateDir), "wux-review");
}

export function runsRoot(options: CleanupPathOptions = {}): string {
  return join(reviewStateRoot(options), "runs");
}

export function legacyCodexHomeRoot(options: CleanupPathOptions = {}): string {
  return join(reviewStateRoot(options), "codex-homes");
}

export function runsTrashRoot(options: CleanupPathOptions = {}): string {
  return join(runsRoot(options), ".trash");
}

function currentUid(): number | undefined {
  return typeof process.getuid === "function" ? process.getuid() : undefined;
}

async function secureDirectory(path: string): Promise<void> {
  const metadata = await lstat(path);
  const uid = currentUid();
  if (
    !metadata.isDirectory()
    || metadata.isSymbolicLink()
    || (uid !== undefined && metadata.uid !== uid)
  ) {
    throw new Error("state root is not a real directory owned by the current user");
  }
  await chmod(path, 0o700);
  const checked = await lstat(path);
  if ((checked.mode & 0o077) !== 0) {
    throw new Error("state root is accessible by another user");
  }
}

export async function ensureRunsRoot(options: CleanupPathOptions = {}): Promise<string> {
  const stateRoot = reviewStateRoot(options);
  const root = runsRoot(options);
  const trash = runsTrashRoot(options);
  await mkdir(stateRoot, { recursive: true, mode: 0o700 });
  await secureDirectory(stateRoot);
  await mkdir(root, { recursive: true, mode: 0o700 });
  await secureDirectory(root);
  await mkdir(trash, { recursive: true, mode: 0o700 });
  await secureDirectory(trash);
  const foreign = (await readdir(root)).filter((name) => name !== ".trash" && !RUN_NAME.test(name));
  if (foreign.length > 0) {
    process.stderr.write(`wux-review: leaving ${foreign.length} unowned ${foreign.length === 1 ? "entry" : "entries"} in runs root\n`);
  }
  return root;
}

function isRunJson(value: unknown): value is RunJson {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  return record.v === 1
    && (record.kind === "claude" || record.kind === "codex")
    && ["createdMs", "deadlineMs", "legMaxMs"].every((key) =>
      typeof record[key] === "number" && Number.isSafeInteger(record[key]) && record[key] >= 0,
    );
}

async function writeRunJson(path: string, value: RunJson): Promise<void> {
  const temporary = join(path, ".run.json.tmp");
  const handle = await open(temporary, fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL, 0o600);
  try {
    await handle.writeFile(`${JSON.stringify(value)}\n`, "utf8");
  } finally {
    await handle.close();
  }
  await rename(temporary, join(path, "run.json"));
}

export async function createRunDirectory(options: CreateRunDirectoryOptions): Promise<RunDirectory> {
  const root = await ensureRunsRoot(options);
  const namePrefix = `r-${options.createdMs.toString(36)}-`;
  const path = await mkdtemp(join(root, namePrefix));
  if (!RUN_NAME.test(basename(path))) {
    throw new Error("created run directory has an unexpected name");
  }
  try {
    await chmod(path, 0o700);
    const cwd = join(path, "cwd");
    await mkdir(cwd, { mode: 0o700 });
    await chmod(cwd, 0o700);
    const home = options.kind === "codex" ? join(path, "home") : undefined;
    if (home !== undefined) {
      await mkdir(home, { mode: 0o700 });
      await chmod(home, 0o700);
    }
    await writeRunJson(path, {
      v: 1,
      kind: options.kind,
      createdMs: options.createdMs,
      deadlineMs: options.deadlineMs,
      legMaxMs: options.legMaxMs,
    });
    return {
      path,
      cwd,
      ...(home === undefined ? {} : { home }),
      cleanup: () => removeOwnedDir(path, options),
    };
  } catch (error) {
    await removeOwnedDir(path, options).catch(() => undefined);
    throw error;
  }
}

// A child-writable cwd and home are never read here. The parent-owned record is
// opened without following links or blocking on special files, and its whole read
// is bounded before JSON is parsed.
export async function readRunJson(path: string): Promise<RunJson | undefined> {
  let handle;
  try {
    handle = await open(join(path, "run.json"), fsConstants.O_RDONLY | fsConstants.O_NONBLOCK | fsConstants.O_NOFOLLOW);
    const metadata = await handle.stat();
    if (!metadata.isFile() || metadata.size > RUN_JSON_LIMIT_BYTES) return undefined;
    const bytes = Buffer.alloc(RUN_JSON_LIMIT_BYTES + 1);
    const { bytesRead } = await handle.read(bytes, 0, bytes.byteLength, 0);
    if (bytesRead > RUN_JSON_LIMIT_BYTES) return undefined;
    const parsed: unknown = JSON.parse(bytes.subarray(0, bytesRead).toString("utf8"));
    if (!isRunJson(parsed)) return undefined;
    const name = RUN_NAME.exec(basename(path));
    const nameCreatedMs = name === null ? undefined : Number.parseInt(name[0].split("-")[1]!, 36);
    return nameCreatedMs !== undefined && parsed.deadlineMs < nameCreatedMs ? undefined : parsed;
  } catch {
    return undefined;
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

function hasDirectChild(path: string, parent: string, predicate: (name: string) => boolean): boolean {
  return path === resolve(path) && dirname(path) === parent && predicate(basename(path));
}

export function validateCleanupDirectory(path: string, options: CleanupPathOptions = {}): boolean {
  if (!isAbsolute(path) || path === "/" || path !== resolve(path)) return false;
  const runRoot = runsRoot(options);
  if (hasDirectChild(path, runRoot, (name) => RUN_NAME.test(name))) return true;

  const homes = legacyCodexHomeRoot(options);
  if (hasDirectChild(path, homes, (name) => name.startsWith("wuxr-codex-home-") && name.length > "wuxr-codex-home-".length)) {
    return true;
  }
  const home = dirname(path);
  if (
    hasDirectChild(path, home, (name) => name.startsWith("wuxr-reviewer-cwd-") && name.length > "wuxr-reviewer-cwd-".length)
    && hasDirectChild(home, homes, (name) => name.startsWith("wuxr-codex-home-") && name.length > "wuxr-codex-home-".length)
  ) {
    return true;
  }
  const temporaryRoot = resolve(options.tempDir ?? tmpdir());
  return hasDirectChild(
    path,
    temporaryRoot,
    (name) => name.startsWith("wuxr-reviewer-cwd-") && name.length > "wuxr-reviewer-cwd-".length,
  );
}

export function cleanupTrashDirectory(path: string, options: CleanupPathOptions = {}): string | undefined {
  return validateCleanupDirectory(path, options) && dirname(path) !== resolve(options.tempDir ?? tmpdir())
    ? runsTrashRoot(options)
    : undefined;
}

export async function removeOwnedDir(path: string, options: CleanupPathOptions = {}): Promise<void> {
  if (!validateCleanupDirectory(path, options)) return;
  let metadata;
  try {
    metadata = await lstat(path);
  } catch (error: unknown) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    throw error;
  }
  if (metadata.isSymbolicLink()) {
    await unlink(path);
    return;
  }
  const uid = currentUid();
  if (!metadata.isDirectory() || (uid !== undefined && metadata.uid !== uid)) return;

  const temporaryRoot = resolve(options.tempDir ?? tmpdir());
  if (dirname(path) === temporaryRoot) {
    await rm(path, { recursive: true, force: true });
    return;
  }
  const trash = runsTrashRoot(options);
  await ensureRunsRoot(options);
  const destination = join(trash, `${basename(path)}.${process.pid}.${Math.random().toString(36).slice(2, 10)}`);
  try {
    await rename(path, destination);
  } catch (error: unknown) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    throw error;
  }
  await rm(destination, { recursive: true, force: true });
}
