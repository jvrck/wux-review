import { mkdir, rename, rm, writeFile } from "node:fs/promises";
import { z } from "zod";
import { validateSessionId } from "./reviewers";
import type { SessionState } from "./types";

// On-disk persistence of per-session prior-round review state (#91). A `--session`
// re-review loads the last round's `ReviewResult` for each leg so the leg reviews
// INCREMENTALLY against its own prior findings (see prompt.ts / pipeline.ts)
// instead of context-free — the fix for re-review oscillation. State lives under
// the same throwaway temp root the reviewer legs use, so it shares their lifetime
// and cleanup story. Loading is best-effort: a missing, unreadable, corrupt, or
// stale-schema file degrades to a context-free review (the pre-#91 behavior),
// never a crash. Saves publish by atomic rename, so a direct round can replace
// a known-corrupt snapshot without risking another partial state file.
// `--end-session` clears it.

const DEFAULT_STATE_DIR = "/tmp/wux-review/sessions";

// The persisted shape, validated on load so a corrupt or stale-schema file is
// ignored (returns undefined) rather than mis-read. Kept lenient (no `.strict()`)
// so a future additive field never fails an old reader.
const findingSchema = z.object({
  lens: z.string(),
  file: z.string(),
  line: z.number().int().nullable(),
  severity: z.enum(["must-fix", "nice-fix", "nit"]),
  finding: z.string(),
  // Optional runnable proof (#101), persisted so a proven blocker's evidence
  // survives across rounds. Optional so pre-#101 state still loads.
  repro: z.string().optional(),
  persistentUnproven: z.boolean().optional(),
});
// One refuted finding in the per-leg ledger (#101).
const refutationEntrySchema = z.object({
  key: z.string(),
  finding: z.string(),
  evidence: z.string(),
  round: z.number().int().min(0),
  // Every repro refuted for this finding; defaulted so an entry written without it
  // still loads.
  refutedRepros: z.array(z.string()).default([]),
});
const resultSchema = z
  .object({
    reviewer: z.enum(["claude", "codex"]),
    findings: z.array(findingSchema),
    verdict: z.enum(["block", "approve"]),
  })
  // The verdict is computed (block iff any must-fix), so we only ever WRITE a
  // consistent result. Reject a file whose persisted verdict disagrees with its
  // findings: a tampered `verdict: "approve"` alongside a must-fix would otherwise
  // make the sticky-approve guard suppress a real block. Inconsistent → ignored
  // (context-free re-review), the module's stated behavior for corrupt state.
  .refine(
    (r) => (r.verdict === "block") === r.findings.some((f) => f.severity === "must-fix"),
    "verdict is inconsistent with findings",
  );
const legExecutionEvidenceSchema = z.object({
  reviewer: z.enum(["claude", "codex"]),
  childName: z.string(),
  attempt: z.number().int().positive(),
  evidencePath: z.string(),
  resultPath: z.string(),
  resultId: z.string(),
  promptSha256: z.string().regex(/^[0-9a-f]{64}$/),
  transientBase: z.string().optional(),
});
const roundEvidenceSchema = z.object({
  round: z.number().int().positive(),
  claude: z.array(legExecutionEvidenceSchema).refine(
    (entries) => entries.every((entry) => entry.reviewer === "claude"),
    "claude evidence contains another reviewer",
  ),
  codex: z.array(legExecutionEvidenceSchema).refine(
    (entries) => entries.every((entry) => entry.reviewer === "codex"),
    "codex evidence contains another reviewer",
  ),
});
const stateSchema = z.object({
  version: z.literal(1),
  // Reviews performed so far in this session (#100). Optional + non-negative so a
  // pre-#100 file (no `round`) still loads; the loader defaults an absent value.
  round: z.number().int().min(0).optional(),
  // Each leg's own result. Reject a file whose leg key disagrees with the stored
  // `reviewer` (e.g. `results.claude.reviewer === "codex"`) — that would be
  // cross-leg leakage into the next round's prompt. Inconsistent → ignored.
  results: z
    .object({ claude: resultSchema, codex: resultSchema })
    .refine((r) => r.claude.reviewer === "claude" && r.codex.reviewer === "codex", "reviewer does not match its leg"),
  // Per-leg accumulated sticky-approve key set. Optional so a state file written
  // by an older build (no `sticky`) still loads — the loader fills empty sets.
  sticky: z.object({ claude: z.array(z.string()), codex: z.array(z.string()) }).optional(),
  // Per-leg refutation ledger (#101). Optional so a pre-#101 file still loads — the
  // loader fills empty ledgers.
  ledger: z
    .object({ claude: z.array(refutationEntrySchema), codex: z.array(refutationEntrySchema) })
    .optional(),
  // Candidate observable child runs (#111). Optional and additive so released
  // session state remains readable by this loader.
  children: z.array(roundEvidenceSchema).optional(),
});

export interface SessionStore {
  load(sessionId: string): Promise<SessionState | undefined>;
  loadForCompare?: (sessionId: string) => Promise<SessionLoadSnapshot>;
  save(sessionId: string, state: SessionState): Promise<void>;
  clear(sessionId: string): Promise<void>;
}

export interface SessionLoadSnapshot {
  state: SessionState | undefined;
  reliable: boolean;
  // A successfully read but invalid file is safe for the lock holder to
  // replace after a context-free direct review. I/O failures are not: they may
  // hide a valid concurrent/newer state and remain fail-closed for writes.
  corrupt?: true;
}

// FS boundary, injected so the store is unit-testable without touching disk and
// so tests can point it at a scratch dir.
export interface SessionStoreDeps {
  stateDir: string;
  readFile: (path: string) => Promise<string | undefined>;
  writeFile: (path: string, content: string) => Promise<void>;
  rename: (from: string, to: string) => Promise<void>;
  mkdir: (path: string) => Promise<void>;
  rm: (path: string) => Promise<void>;
}

function defaultDeps(): SessionStoreDeps {
  return {
    stateDir: DEFAULT_STATE_DIR,
    readFile: async (path) => {
      const file = Bun.file(path);
      return (await file.exists()) ? file.text() : undefined;
    },
    writeFile: (path, content) => writeFile(path, content, {
      encoding: "utf8",
      mode: 0o600,
    }),
    rename,
    mkdir: (path) => mkdir(path, { recursive: true }).then(() => undefined),
    rm: (path) => rm(path, { force: true }).then(() => undefined),
  };
}

// The state file path for a session. `validateSessionId` — the same guard the
// reviewer legs use for tmux/temp-file names — rejects any id with a path
// separator or metacharacter, so the id is a safe slug before it is interpolated
// into the path (no traversal via `--session ../x`).
function statePath(deps: SessionStoreDeps, sessionId: string): string {
  validateSessionId(sessionId);
  return `${deps.stateDir}/${sessionId}.json`;
}

export function createSessionStore(overrides: Partial<SessionStoreDeps> = {}): SessionStore {
  const deps = { ...defaultDeps(), ...overrides };
  return {
    async load(sessionId) {
      return (await loadSnapshot(deps, sessionId)).state;
    },
    async loadForCompare(sessionId) {
      return loadSnapshot(deps, sessionId);
    },
    async save(sessionId, state) {
      const path = statePath(deps, sessionId);
      // The shared full-round session lock guarantees one writer per id. A
      // fixed temporary path is therefore collision-free and lets the next
      // load promote or discard a crash remnant deterministically.
      const temporaryPath = `${path}.tmp`;
      await deps.mkdir(deps.stateDir);
      try {
        await deps.writeFile(temporaryPath, JSON.stringify(state));
        await deps.rename(temporaryPath, path);
      } finally {
        await deps.rm(temporaryPath).catch(() => undefined);
      }
    },
    async clear(sessionId) {
      const path = statePath(deps, sessionId);
      await Promise.all([
        deps.rm(path).catch(() => undefined),
        deps.rm(`${path}.tmp`).catch(() => undefined),
      ]);
    },
  };
}

async function loadSnapshot(
  deps: SessionStoreDeps,
  sessionId: string,
): Promise<SessionLoadSnapshot> {
  const path = statePath(deps, sessionId);
  const temporaryPath = `${path}.tmp`;
  let raw: string | undefined;
  let temporaryRaw: string | undefined;
  try {
    [raw, temporaryRaw] = await Promise.all([
      deps.readFile(path),
      deps.readFile(temporaryPath),
    ]);
  } catch {
    return { state: undefined, reliable: false };
  }
  if (temporaryRaw !== undefined) {
    const temporaryState = parseSessionState(temporaryRaw);
    if (temporaryState !== undefined) {
      try {
        await deps.rename(temporaryPath, path);
      } catch {
        return { state: undefined, reliable: false };
      }
      return { state: temporaryState, reliable: true };
    }
    await deps.rm(temporaryPath).catch(() => undefined);
  }
  if (raw === undefined) return { state: undefined, reliable: true };
  if (raw.trim() === "") {
    return { state: undefined, reliable: false, corrupt: true };
  }
  const state = parseSessionState(raw);
  if (state === undefined) {
    return { state: undefined, reliable: false, corrupt: true };
  }
  return { state, reliable: true };
}

function parseSessionState(raw: string): SessionState | undefined {
  let data: unknown;
  try {
    data = JSON.parse(raw);
  } catch {
    return undefined;
  }
  const parsed = stateSchema.safeParse(data);
  if (!parsed.success) return undefined;
  // Fill absent additive fields (older state files) so callers always get a
  // fully-formed SessionState.
  return {
    ...parsed.data,
    round: parsed.data.round ?? 0,
    sticky: parsed.data.sticky ?? { claude: [], codex: [] },
    ledger: parsed.data.ledger ?? { claude: [], codex: [] },
  } as SessionState;
}

// The default store used by the pipeline + `--end-session`. Tests inject their
// own via `createSessionStore({ stateDir })` or a hand-built in-memory SessionStore.
export const defaultSessionStore: SessionStore = createSessionStore();
