import {
  mkdir,
  open,
  readFile as readTextFile,
  readdir,
  rename,
  rm,
  rmdir,
  stat,
  writeFile as writeTextFile,
} from "node:fs/promises";
import { readFileSync } from "node:fs";
import { createHash, randomUUID } from "node:crypto";
import { basename } from "node:path";
import { z } from "zod";
import { WuxReviewError } from "../runtime/errors";
import {
  observableAttemptChildName,
  observableAttemptForChild,
} from "./observable-attempt";
import { validateSessionId } from "./reviewers";
import type {
  LegExecutionEvidence,
  ObservableLifecycleState,
  RefutationEntry,
  ReviewerName,
  ReviewResult,
  SessionState,
} from "./types";

const DEFAULT_ROUND_DIR = "/tmp/wux-review/observable-rounds";
const DEFAULT_RETENTION_DAYS = 7;
const INCOMPLETE_LOCK_STALE_MS = 30 * 1000;

const findingLedgerSchema = z.object({
  key: z.string(),
  finding: z.string(),
  evidence: z.string(),
  round: z.number().int().min(0),
  refutedRepros: z.array(z.string()),
});
const finalFindingSchema = z.object({
  lens: z.string(),
  file: z.string(),
  line: z.number().int().nullable(),
  severity: z.enum(["must-fix", "nice-fix", "nit"]),
  finding: z.string(),
  repro: z.string().optional(),
  persistentUnproven: z.boolean().optional(),
}).strict();
const finalResultSchema = z.object({
  reviewer: z.enum(["claude", "codex"]),
  findings: z.array(finalFindingSchema),
  verdict: z.enum(["block", "approve"]),
}).strict();
const evidenceSchema = z.object({
  reviewer: z.enum(["claude", "codex"]),
  childName: z.string(),
  attempt: z.number().int().positive(),
  evidencePath: z.string(),
  resultPath: z.string(),
  resultId: z.string().min(1),
  promptSha256: z.string().regex(/^[0-9a-f]{64}$/),
  transientBase: z.string(),
  // Optional only for read compatibility with terminal journals written by
  // the pre-authentication candidate. Reconciliation itself requires it.
  ownedCleanupKey: z.string().regex(/^[0-9a-f]{64}$/).optional(),
  eventPrefix: z.object({
    bytes: z.number().int().positive(),
    sha256: z.string().regex(/^[0-9a-f]{64}$/),
  }).strict().optional(),
  wrapperExitedNormally: z.boolean().optional(),
  cleanupFiles: z.array(z.string()).optional(),
  cleanupDir: z.string().optional(),
});
const stateSchema = z.enum([
  "pending",
  "running",
  "completed",
  "failed",
  "timed_out",
  "tainted",
  "interrupted",
  "reconciled",
  "finalizing",
]);
const roundSchema = z.object({
  version: z.literal(1),
  reviewId: z.string(),
  round: z.number().int().positive(),
  executionId: z.string(),
  sessionMode: z.boolean(),
  priorStateSha256: z.string().regex(/^[0-9a-f]{64}$/).nullable(),
  expected: z.object({
    claudeChildName: z.string(),
    codexChildName: z.string(),
  }).strict(),
  prepared: z.object({
    claude: z.array(z.string()),
    codex: z.array(z.string()),
  }).strict().optional(),
  ledger: z.object({
    claude: z.array(findingLedgerSchema),
    codex: z.array(findingLedgerSchema),
  }).strict(),
  evidence: z.object({
    claude: z.array(evidenceSchema),
    codex: z.array(evidenceSchema),
  }).strict(),
  state: stateSchema,
  startedAt: z.string(),
  updatedAt: z.string(),
  diagnostic: z.string().optional(),
  cleanupPending: z.boolean().optional(),
  finalization: z.object({
    sessionStateSha256: z.string().regex(/^[0-9a-f]{64}$/).nullable(),
    results: z.object({
      claude: finalResultSchema,
      codex: finalResultSchema,
    }).strict().refine(
      (results) =>
        results.claude.reviewer === "claude"
        && results.codex.reviewer === "codex",
      "reviewer does not match its finalization leg",
    ),
  }).strict().optional(),
}).strict().superRefine((record, context) => {
  if (record.state === "finalizing" && record.finalization === undefined) {
    context.addIssue({
      code: "custom",
      message: "finalizing state requires a finalization journal",
    });
  }
  if (
    record.cleanupPending === true
    && !["failed", "timed_out", "tainted"].includes(record.state)
  ) {
    context.addIssue({
      code: "custom",
      path: ["cleanupPending"],
      message: "pending cleanup requires a terminal failure state",
    });
  }
  if (
    record.finalization !== undefined
    && (record.finalization.sessionStateSha256 !== null) !== record.sessionMode
  ) {
    context.addIssue({
      code: "custom",
      message: "finalization session hash does not match session mode",
    });
  }
  if (record.prepared !== undefined) {
    for (const reviewer of ["claude", "codex"] as const) {
      const expected = reviewer === "claude"
        ? record.expected.claudeChildName
        : record.expected.codexChildName;
      const children = record.prepared[reviewer];
      if (!children.includes(expected)) {
        context.addIssue({
          code: "custom",
          path: ["prepared", reviewer],
          message: "prepared children must include the base attempt",
        });
      }
      const attempts = children.map((childName) =>
        observableAttemptForChild(expected, childName)
      );
      if (
        new Set(children).size !== children.length
        || attempts.some((attempt, index) => attempt !== index + 1)
      ) {
        context.addIssue({
          code: "custom",
          path: ["prepared", reviewer],
          message: "prepared child identity is duplicate or outside the round",
        });
      }
    }
    if (
      record.prepared.claude.some((childName) =>
        record.prepared!.codex.includes(childName)
      )
    ) {
      context.addIssue({
        code: "custom",
        path: ["prepared"],
        message: "prepared child identity is shared across reviewers",
      });
    }
  }
});

export type ObservableRoundState = ObservableLifecycleState | "finalizing";

export interface ObservableRoundRecord {
  version: 1;
  reviewId: string;
  round: number;
  executionId: string;
  sessionMode: boolean;
  priorStateSha256: string | null;
  expected: {
    claudeChildName: string;
    codexChildName: string;
  };
  prepared?: {
    claude: string[];
    codex: string[];
  };
  ledger: {
    claude: RefutationEntry[];
    codex: RefutationEntry[];
  };
  evidence: {
    claude: LegExecutionEvidence[];
    codex: LegExecutionEvidence[];
  };
  state: ObservableRoundState;
  startedAt: string;
  updatedAt: string;
  diagnostic?: string;
  cleanupPending?: boolean;
  finalization?: {
    sessionStateSha256: string | null;
    results: {
      claude: ReviewResult;
      codex: ReviewResult;
    };
  };
}

export interface ObservableRoundStore {
  load(reviewId: string): Promise<ObservableRoundRecord | undefined>;
  save(record: ObservableRoundRecord): Promise<void>;
  clear(reviewId: string): Promise<void>;
  prune(now?: Date): Promise<void>;
}

export interface ObservableRoundStoreDeps {
  stateDir: string;
  readFile: (path: string) => Promise<string | undefined>;
  writeFile: (path: string, content: string) => Promise<void>;
  rename: (from: string, to: string) => Promise<void>;
  mkdir: (path: string) => Promise<void>;
  rm: (path: string) => Promise<void>;
  removeDir: (path: string) => Promise<void>;
  list: (path: string) => Promise<string[]>;
  retentionDays: number;
}

function defaultDeps(): ObservableRoundStoreDeps {
  return {
    stateDir: DEFAULT_ROUND_DIR,
    readFile: async (path) => {
      const file = Bun.file(path);
      return (await file.exists()) ? file.text() : undefined;
    },
    writeFile: (path, content) => writeTextFile(path, content, {
      encoding: "utf8",
      mode: 0o600,
    }),
    rename,
    mkdir: (path) => mkdir(path, { recursive: true, mode: 0o700 }).then(() => undefined),
    rm: (path) => rm(path, { force: true }).then(() => undefined),
    removeDir: (path) => rmdir(path).then(() => undefined),
    list: async (path) => {
      try {
        return await readdir(path);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
        throw error;
      }
    },
    retentionDays: retentionDays(),
  };
}

export function createObservableRoundStore(
  overrides: Partial<ObservableRoundStoreDeps> = {},
): ObservableRoundStore {
  const deps = { ...defaultDeps(), ...overrides };
  return {
    async load(reviewId) {
      const path = roundPath(deps, reviewId);
      const raw = await deps.readFile(path);
      const partial = await deps.readFile(`${path}.tmp`);
      if (partial !== undefined) {
        let parsedPartial: ReturnType<typeof roundSchema.safeParse> | undefined;
        try {
          parsedPartial = roundSchema.safeParse(JSON.parse(partial));
        } catch {
          parsedPartial = undefined;
        }
        if (
          parsedPartial?.success === true
          && parsedPartial.data.reviewId === reviewId
        ) {
          // A surviving valid tmp is the newest attempted atomic write. save()
          // always renames away its tmp, so coexistence with an older main file
          // means the process crashed after writing the next journal but before
          // rename. Promote it instead of discarding newly checkpointed evidence.
          await deps.rename(`${path}.tmp`, path);
          return parsedPartial.data as ObservableRoundRecord;
        }
        await deps.rm(`${path}.tmp`).catch(() => undefined);
      }
      if (raw === undefined || raw.trim() === "") return undefined;
      let value: unknown;
      try {
        value = JSON.parse(raw);
      } catch {
        throw new WuxReviewError(`observable round ${reviewId}: malformed recovery state at ${path}`);
      }
      const parsed = roundSchema.safeParse(value);
      if (!parsed.success || parsed.data.reviewId !== reviewId) {
        throw new WuxReviewError(`observable round ${reviewId}: invalid recovery state at ${path}`);
      }
      return parsed.data as ObservableRoundRecord;
    },
    async save(record) {
      validateRoundRecord(record);
      const path = roundPath(deps, record.reviewId);
      const tmp = `${path}.tmp`;
      await deps.mkdir(deps.stateDir);
      await deps.writeFile(tmp, `${JSON.stringify(record)}\n`);
      await deps.rename(tmp, path);
    },
    async clear(reviewId) {
      const path = roundPath(deps, reviewId);
      await Promise.all([
        deps.rm(path).catch(() => undefined),
        deps.rm(`${path}.tmp`).catch(() => undefined),
      ]);
    },
    async prune(now = new Date()) {
      if (!Number.isFinite(deps.retentionDays) || deps.retentionDays < 0) return;
      const cutoff = now.getTime() - deps.retentionDays * 24 * 60 * 60 * 1000;
      for (const name of await deps.list(deps.stateDir)) {
        if (/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}\.locks$/.test(name)) {
          const lockDir = `${deps.stateDir}/${name}`;
          const tickets = await deps.list(lockDir).catch(() => []);
          if (tickets.length === 0) {
            await deps.removeDir(lockDir).catch(() => undefined);
          }
          continue;
        }
        if (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}\.json$/.test(name)) continue;
        const path = `${deps.stateDir}/${name}`;
        const raw = await deps.readFile(path).catch(() => undefined);
        if (raw === undefined) continue;
        try {
          const parsed = roundSchema.safeParse(JSON.parse(raw));
          if (!parsed.success) continue;
          const updated = Date.parse(parsed.data.updatedAt);
          const terminal = [
            "completed",
            "failed",
            "timed_out",
            "tainted",
            "reconciled",
          ].includes(parsed.data.state);
          if (
            terminal
            && parsed.data.cleanupPending !== true
            && Number.isFinite(updated)
            && updated < cutoff
          ) {
            await deps.rm(path).catch(() => undefined);
            await deps.rm(`${path}.tmp`).catch(() => undefined);
          }
        } catch {
          // Preserve malformed recovery evidence for an operator to inspect.
        }
      }
    },
  };
}

export function sessionStateSha256(state: SessionState | undefined): string | null {
  return state === undefined
    ? null
    : createHash("sha256").update(canonicalJson(state)).digest("hex");
}

function canonicalJson(value: unknown): string {
  return JSON.stringify(sortJsonValue(value));
}

function sortJsonValue(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map((entry) =>
      entry === undefined ? null : sortJsonValue(entry)
    );
  }
  if (typeof value !== "object" || value === null) return value;
  return Object.fromEntries(
    Object.entries(value)
      .filter(([, entry]) => entry !== undefined)
      .sort(([left], [right]) =>
        left < right ? -1 : left > right ? 1 : 0
      )
      .map(([key, entry]) => [key, sortJsonValue(entry)]),
  );
}

export async function acquireObservableRecoveryLock(
  reviewId: string,
  stateDir = DEFAULT_ROUND_DIR,
): Promise<() => Promise<void>> {
  validateSessionId(reviewId);
  const lockDir = `${stateDir}/${reviewId}.locks`;
  // Every contender owns a unique, never-reused ticket path. Stale cleanup can
  // therefore unlink only the exact crashed ticket it inspected; it can never
  // delete a newly-acquired replacement at a shared pathname.
  const ticketPath = `${lockDir}/${process.pid}-${randomUUID()}.lock`;
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  let observedBeforeTicket = new Set<string>();
  for (let attempt = 0; attempt < 3; attempt++) {
    await mkdir(lockDir, { recursive: true, mode: 0o700 });
    observedBeforeTicket = new Set(
      await readdir(lockDir).catch(() => [] as string[]),
    );
    try {
      handle = await open(ticketPath, "wx", 0o600);
      break;
    } catch (error) {
      if (
        (error as NodeJS.ErrnoException).code !== "ENOENT"
        || attempt === 2
      ) {
        throw error;
      }
    }
  }
  if (handle === undefined) {
    throw new WuxReviewError(
      `observable round ${reviewId}: could not initialize recovery lock`,
    );
  }
  try {
    await handle.writeFile(`${JSON.stringify({
      pid: process.pid,
      processIdentity: processStartIdentity(process.pid),
    })}\n`, "utf8");
  } catch (error) {
    await handle.close().catch(() => undefined);
    await rm(ticketPath, { force: true }).catch(() => undefined);
    throw error;
  } finally {
    await handle.close().catch(() => undefined);
  }

  try {
    const active: Array<{ name: string; createdAt: bigint }> = [];
    for (const name of await readdir(lockDir)) {
      if (!name.endsWith(".lock")) continue;
      const path = `${lockDir}/${name}`;
      const raw = await readTextFile(path, "utf8").catch(() => "");
      const owner = parseLockOwner(raw);
      const metadata = await stat(path, { bigint: true }).catch(() => undefined);
      if (metadata === undefined) continue;
      const age = Date.now() - Number(metadata.mtimeMs);
      const live = owner === undefined
        ? age <= INCOMPLETE_LOCK_STALE_MS
        : processIsAlive(owner.pid)
          && (
            owner.processIdentity === undefined
            || processIdentityMatches(owner.pid, owner.processIdentity)
          );
      if (live) {
        active.push({
          name,
          createdAt: metadata.birthtimeNs || metadata.ctimeNs,
        });
      } else {
        // Unique ticket names make this exact-path reclamation race-safe: no
        // later owner can recreate the path being removed.
        await rm(path, { force: true });
      }
    }
    active.sort((left, right) =>
      left.createdAt < right.createdAt
        ? -1
        : left.createdAt > right.createdAt
          ? 1
          : left.name < right.name
            ? -1
            : left.name > right.name
              ? 1
              : 0
    );
    const activePredecessor = active.some(
      (entry) =>
        entry.name !== basename(ticketPath)
        && observedBeforeTicket.has(entry.name),
    );
    if (activePredecessor || active[0]?.name !== basename(ticketPath)) {
      throw new WuxReviewError(
        `review session ${reviewId}: another review or reconciliation is already in progress`,
      );
    }
  } catch (error) {
    await rm(ticketPath, { force: true }).catch(() => undefined);
    throw error;
  }

  return async () => {
    await rm(ticketPath, { force: true });
    // A contender whose mkdir/open window loses this race retries ENOENT above.
    // If it already published a ticket, rmdir fails harmlessly with ENOTEMPTY.
    await rmdir(lockDir).catch(() => undefined);
  };
}

export function appendRoundEvidence(
  record: ObservableRoundRecord,
  evidence: LegExecutionEvidence,
  at: string,
): ObservableRoundRecord {
  if (evidence.transientBase === undefined) {
    throw new WuxReviewError(
      `${evidence.childName} observable reviewer leg: missing reconciliation bootstrap identity`,
    );
  }
  const expected = evidence.reviewer === "claude"
    ? record.expected.claudeChildName
    : record.expected.codexChildName;
  const expectedChild = observableAttemptChildName(expected, evidence.attempt);
  if (evidence.childName !== expectedChild) {
    throw new WuxReviewError(
      `${evidence.childName} observable reviewer leg: cross-leg or stale recovery identity`,
    );
  }
  if (
    record.prepared !== undefined
    && !record.prepared[evidence.reviewer].includes(evidence.childName)
  ) {
    throw new WuxReviewError(
      `${evidence.childName} observable reviewer leg: recovery evidence was not prepared`,
    );
  }
  const entries = record.evidence[evidence.reviewer];
  const existingIndex = entries.findIndex(
    (entry) => entry.attempt === evidence.attempt,
  );
  if (existingIndex !== -1) {
    const existing = entries[existingIndex]!;
    const {
      eventPrefix: priorPrefix,
      wrapperExitedNormally: priorWrapperExit,
      ...priorIdentity
    } = existing;
    const {
      eventPrefix: nextPrefix,
      wrapperExitedNormally: nextWrapperExit,
      ...nextIdentity
    } = evidence;
    if (
      JSON.stringify(priorIdentity) !== JSON.stringify(nextIdentity)
      || (priorWrapperExit === true && nextWrapperExit !== true)
      || nextPrefix === undefined
      || (
        priorPrefix !== undefined
        && nextPrefix.bytes <= priorPrefix.bytes
      )
    ) {
      throw new WuxReviewError(
        `${evidence.childName} observable reviewer leg: duplicate or regressed recovery evidence`,
      );
    }
    return {
      ...record,
      state: "running",
      updatedAt: at,
      evidence: {
        ...record.evidence,
        [evidence.reviewer]: entries.map((entry, index) =>
          index === existingIndex ? evidence : entry
        ),
      },
    };
  }
  if (
    [...record.evidence.claude, ...record.evidence.codex].some(
      (entry) =>
        entry.resultId === evidence.resultId
        || entry.resultPath === evidence.resultPath,
    )
  ) {
    throw new WuxReviewError(
      `${evidence.childName} observable reviewer leg: duplicate recovery evidence`,
    );
  }
  return {
    ...record,
    state: "running",
    updatedAt: at,
    evidence: {
      ...record.evidence,
      [evidence.reviewer]: [...entries, evidence],
    },
  };
}

export function appendPreparedChild(
  record: ObservableRoundRecord,
  reviewer: ReviewerName,
  childName: string,
  attempt: number,
  at: string,
): ObservableRoundRecord {
  const expected = reviewer === "claude"
    ? record.expected.claudeChildName
    : record.expected.codexChildName;
  if (
    !Number.isSafeInteger(attempt)
    || attempt < 1
    || observableAttemptForChild(expected, childName) !== attempt
  ) {
    throw new WuxReviewError(
      `${childName} observable reviewer leg: cross-leg or stale prepared identity`,
    );
  }
  const prepared = record.prepared ?? {
    claude: [record.expected.claudeChildName],
    codex: [record.expected.codexChildName],
  };
  if (prepared[reviewer].includes(childName)) return record;
  if (attempt !== prepared[reviewer].length + 1) {
    throw new WuxReviewError(
      `${childName} observable reviewer leg: non-sequential prepared attempt`,
    );
  }
  return {
    ...record,
    prepared: {
      ...prepared,
      [reviewer]: [...prepared[reviewer], childName],
    },
    updatedAt: at,
  };
}

function roundPath(
  deps: Pick<ObservableRoundStoreDeps, "stateDir">,
  reviewId: string,
): string {
  validateSessionId(reviewId);
  return `${deps.stateDir}/${reviewId}.json`;
}

function validateRoundRecord(record: ObservableRoundRecord): void {
  const parsed = roundSchema.safeParse(record);
  if (!parsed.success) {
    throw new WuxReviewError(`observable round ${record.reviewId}: invalid recovery state`);
  }
  validateSessionId(record.reviewId);
}

function retentionDays(): number {
  const raw = process.env.WUX_REVIEW_OBSERVABLE_RECOVERY_RETENTION_DAYS;
  if (raw === undefined || raw.trim() === "") return DEFAULT_RETENTION_DAYS;
  const value = Number(raw);
  return Number.isFinite(value) && value >= 0
    ? Math.floor(value)
    : DEFAULT_RETENTION_DAYS;
}

function processIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

interface LockOwner {
  pid: number;
  processIdentity?: string;
}

function parseLockOwner(raw: string): LockOwner | undefined {
  try {
    const parsed: unknown = JSON.parse(raw);
    // Pre-incarnation lock tickets stored only the numeric PID. A JSON number
    // parses successfully, so recognize it here rather than relying on the
    // syntax-error fallback. Without an incarnation token a live PID must be
    // preserved conservatively: age cannot prove that its lock is abandoned.
    if (Number.isSafeInteger(parsed) && Number(parsed) > 0) {
      return { pid: Number(parsed) };
    }
    if (
      typeof parsed === "object"
      && parsed !== null
      && "pid" in parsed
      && Number.isSafeInteger(parsed.pid)
      && Number(parsed.pid) > 0
    ) {
      const processIdentity = "processIdentity" in parsed
        && typeof parsed.processIdentity === "string"
        && parsed.processIdentity !== ""
        ? parsed.processIdentity
        : undefined;
      return {
        pid: Number(parsed.pid),
        ...(processIdentity === undefined ? {} : { processIdentity }),
      };
    }
  } catch {
    const pid = Number.parseInt(raw.trim(), 10);
    if (Number.isSafeInteger(pid) && pid > 0) return { pid };
  }
  return undefined;
}

function processIdentityMatches(pid: number, expected: string): boolean {
  const actual = processStartIdentity(pid);
  // If the platform cannot expose a start identity, conservatively preserve a
  // live ticket. Reclaiming it would let two owners mutate the same round.
  return actual === undefined || actual === expected;
}

function processStartIdentity(pid: number): string | undefined {
  if (process.platform === "linux") {
    try {
      const statLine = readFileSync(`/proc/${pid}/stat`, "utf8");
      const commandEnd = statLine.lastIndexOf(")");
      if (commandEnd === -1) return undefined;
      const fields = statLine.slice(commandEnd + 2).trim().split(/\s+/);
      const startTicks = fields[19];
      return startTicks === undefined ? undefined : `linux:${startTicks}`;
    } catch {
      return undefined;
    }
  }
  if (process.platform === "darwin") {
    try {
      const result = Bun.spawnSync(
        ["/bin/ps", "-o", "lstart=", "-p", String(pid)],
        { stdout: "pipe", stderr: "ignore" },
      );
      if (result.exitCode !== 0) return undefined;
      const started = new TextDecoder().decode(result.stdout).trim();
      return started === "" ? undefined : `darwin:${started}`;
    } catch {
      return undefined;
    }
  }
  return undefined;
}

export const defaultObservableRoundStore = createObservableRoundStore();
