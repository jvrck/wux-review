import { constants as fsConstants } from "node:fs";
import type { Dirent } from "node:fs";
import { chmod, copyFile, mkdir, mkdtemp, open, readdir, rm } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { errorDetail, oneLine, WuxReviewError } from "../runtime/errors";
import type { Backend, BackendOptions } from "../review/reviewers";
import type { ReviewerName } from "../review/types";
import { REVIEWER_STDERR_TAIL_BYTES } from "./capture-limits";
import {
  ObservableLifecycleError,
  runObservableLeg,
  type ObservableAdapterDeps,
} from "./observable";
import {
  isClaudeResultEvent,
  MACHINE_RESULT_EVENT_LIMIT_BYTES,
} from "./observable-events";

// Headless reviewer legs: drive each model as a one-shot, non-interactive
// subprocess that runs the review and *exits* — no `wux run` TUI, no instruction
// pasted into one, no sentinel-file polling. That interactive send-into-a-TUI
// path was the unattended chokepoint that stalled and timed out with an empty
// verdict; a bounded subprocess that terminates on completion removes it entirely.
//
// The Claude leg lives here; the Codex leg is added alongside it. Both keep the
// existing `Backend` contract (return the reviewer's raw text for `parseReport`)
// and inject all process/FS I/O so the boundary is unit-testable without a live
// model.

// Default per-leg wall-clock *base* bounds. Claude's current review latency needs
// a more patient unattended default than codex; successful legs still return the
// instant their process exits, so the larger Claude value adds patience without
// adding happy-path latency. WUX_REVIEW_TIMEOUT_MS remains the shared override for
// backward compatibility, while each leg also has its own higher-precedence base
// override (#107).
const DEFAULT_CODEX_TIMEOUT_MS = 4 * 60 * 1000;
const DEFAULT_CLAUDE_TIMEOUT_MS = 15 * 60 * 1000;

// Upper bound for the size-aware timeout: a very large diff earns more wall-clock,
// but never an unbounded wait — a leg that needs more than this has genuinely
// failed and surfaces as a typed timeout, not a silent hang. The size-aware bound
// only caps *patience* (a leg that finishes early returns the instant its process
// exits), so a generous cap never slows a successful review.
const DEFAULT_CODEX_MAX_TIMEOUT_MS = 10 * 60 * 1000;
const DEFAULT_CLAUDE_MAX_TIMEOUT_MS = 25 * 60 * 1000;

// Extra wall-clock granted per KB of prompt (diff + lenses). A leg reads the whole
// brief before its first turn, so a larger diff legitimately needs proportionally
// more time; scaling the bound with the work beats guessing one fixed ceiling.
// This was the codex-leg fix in #85 (DEFAULT_CODEX_*); #99 gives the Claude leg the
// same treatment. The Claude leg gets a more generous per-KB default: `claude -p`
// on a large diff is slower to first output than `codex exec`, and because the
// bound is only a patience ceiling (never a floor), the extra headroom is free on
// the happy path and is what stops a large diff dying at the flat 240s default.
const DEFAULT_CODEX_TIMEOUT_PER_KB_MS = 250;
const DEFAULT_CLAUDE_TIMEOUT_PER_KB_MS = 1000;

// Bounded retry for a transient codex `exit-1` / empty-verdict flake (the #85 eval
// saw fix-131 fail 4 of 6 attempts). A transient leg failure is retried with
// exponential backoff so a verdict is never lost to a flake; a persistent failure
// still surfaces as a typed error once the attempts are spent. A timeout is NOT
// retried (that only doubles the wait) — it surfaces immediately.
const DEFAULT_CODEX_RETRIES = 2;
const DEFAULT_CODEX_RETRY_BASE_MS = 1000;

// The exported process runner is memory-safe even when a caller omits explicit
// capture limits. Reviewer paths narrow this further (Codex stdout is discarded);
// general callers retain at most a final-Claude-event-sized stdout tail and the
// same 256 KiB stderr diagnostic tail used by reviewer legs.
// The two extra bytes retain CRLF framing around an exact-limit JSON event.
export const HEADLESS_DEFAULT_STDOUT_TAIL_BYTES = MACHINE_RESULT_EVENT_LIMIT_BYTES + 2;
export const HEADLESS_DEFAULT_STDERR_TAIL_BYTES = REVIEWER_STDERR_TAIL_BYTES;

// Only auth/install identity is copied byte-for-byte into a reviewer home.
// TOML config layers are parsed and allowlisted separately; mutable model caches
// are not trusted as reviewer input and Codex can recreate them inside the
// throwaway home.
const CODEX_HOME_SEED_FILES = ["auth.json", "version.json", "installation_id"];

// Config is untrusted setup input and is read before the bounded reviewer child
// exists. Keep each layer small enough that a regular file cannot exhaust setup
// memory, even if it grows after the initial metadata check.
const MAX_CODEX_CONFIG_BYTES = 1024 * 1024;

// Scalar routing/model/request-shape fields re-derived from Codex 0.147.0's
// ConfigToml surface. Filesystem-backed catalogs/instructions and personality
// customizations are deliberately absent, as are executable surfaces — notify,
// hooks, MCP, plugins, skills, tools, project trust, and features. Base config,
// legacy profile tables, and separate <name>.config.toml layers all receive this
// same allowlist.
const CODEX_MODEL_CONFIG_KEYS = [
  "model",
  "review_model",
  "model_provider",
  "model_context_window",
  "model_auto_compact_token_limit",
  "model_auto_compact_token_limit_scope",
  "model_reasoning_effort",
  "plan_mode_reasoning_effort",
  "model_reasoning_summary",
  "model_verbosity",
  "service_tier",
  "chatgpt_base_url",
  "openai_base_url",
  "oss_provider",
] as const;

// Scale a leg's wall-clock bound with the prompt size: base + perKB·KB, capped at
// maxMs. A small diff leaves the base bound unchanged; a large diff earns more
// time, up to the cap. Used by BOTH legs (#99) — the helper is identical; the two
// legs differ only by their per-leg knobs. Exported for unit tests.
export function sizeAwareTimeoutMs(baseMs: number, promptBytes: number, perKbMs: number, maxMs: number): number {
  const kb = Math.max(0, promptBytes) / 1024;
  return Math.min(maxMs, Math.round(baseMs + kb * perKbMs));
}

// An actionable timeout message for a leg that overran its (size-aware) bound.
// Naming the prompt size and the env var that raises the ceiling is the fix for
// #99: a timed-out leg previously read as flaky infrastructure, with nothing
// pointing the operator at the configurable bound or the diff-size relationship.
// The lever named is the one that actually moves this bound: while the size-aware
// value is below the per-leg cap, raising that leg's *_TIMEOUT_MS lifts it; once
// the bound has been clamped to the cap, only raising that leg's *_MAX_TIMEOUT_MS
// does — so a capped overrun never points at a base var that would have no effect.
function timeoutMessage(leg: ReviewerName, timeoutMs: number, promptBytes: number, maxMs: number): string {
  const kb = Math.round(Math.max(0, promptBytes) / 1024);
  const prefix = `WUX_REVIEW_${leg.toUpperCase()}`;
  const lever = timeoutMs >= maxMs ? `raise ${prefix}_MAX_TIMEOUT_MS` : `raise ${prefix}_TIMEOUT_MS`;
  return `${leg} reviewer timed out after ${Math.round(timeoutMs / 1000)}s (prompt ${kb} KB; ${lever})`;
}

function timeoutStartMessage(
  leg: ReviewerName,
  timeoutMs: number,
  promptBytes: number,
  perAttempt = false,
): string {
  const kb = Math.round(Math.max(0, promptBytes) / 1024);
  const suffix = perAttempt ? " per attempt" : "";
  return `wux-review: ${leg} reviewer starting (prompt ${kb} KB; timeout budget ${Math.round(timeoutMs / 1000)}s${suffix})`;
}

// Parse a non-negative integer env override, falling back on absence or garbage.
function envInt(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === "") return fallback;
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 ? Math.floor(n) : fallback;
}

// A bounded process exec with optional stdin. Unlike the plain `Run` used for
// git/gh (no stdin, no timeout), a reviewer leg must (a) feed the prompt in and
// (b) be killed if it ever fails to terminate, so the verdict path is bounded.
export interface HeadlessRunOptions {
  stdin?: string;
  cwd?: string;
  timeoutMs: number;
  // Retain only the newest bytes while still draining the full stream. Reviewer
  // machine stdout is high-volume evidence; Claude needs only its bounded final
  // result window, while Codex's authoritative verdict comes from `-o`.
  stdoutTailBytes?: number;
  stderrTailBytes?: number;
  // Extra environment merged over the parent env (undefined inherits it
  // unchanged). Used to point the codex leg at an isolated CODEX_HOME.
  env?: Record<string, string>;
}

export interface HeadlessRunResult {
  code: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  stdoutTruncated?: boolean;
  stdoutTailStartsAtLineBoundary?: boolean;
  // Candidate observable transport only: a validated output file (Codex `-o`)
  // read back through the atomic result.json contract.
  structuredOutput?: string;
}

export type HeadlessRun = (cmd: string[], opts: HeadlessRunOptions) => Promise<HeadlessRunResult>;

export const defaultHeadlessRun: HeadlessRun = async (cmd, opts) => {
  const proc = Bun.spawn(cmd, {
    cwd: opts.cwd,
    stdin: opts.stdin === undefined ? "ignore" : new TextEncoder().encode(opts.stdin),
    stdout: "pipe",
    stderr: "pipe",
    // Bun replaces the env wholesale when `env` is set, so inherit explicitly.
    env: opts.env === undefined ? undefined : { ...process.env, ...opts.env },
  });
  // Bound on the *process*, not on stream EOF. `new Response(stream).text()`
  // resolves only when every write-end of the pipe is closed — and `claude` /
  // `codex` spawn child processes (MCP servers, hooks, sandbox helpers) that
  // inherit stdout/stderr, so a leftover grandchild keeps the pipe open long
  // after the leg should have been killed. We therefore read via cancellable
  // readers and, on timeout, SIGKILL the direct child *and* cancel the readers
  // so the call returns promptly (verified: ~0.3s vs a 30s grandchild hold)
  // instead of blocking on an EOF that may never arrive.
  const outReader = proc.stdout.getReader();
  const errReader = proc.stderr.getReader();
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    proc.kill("SIGKILL");
    outReader.cancel().catch(() => undefined);
    errReader.cancel().catch(() => undefined);
  }, opts.timeoutMs);
  try {
    const [stdout, stderr, code] = await Promise.all([
      readAll(
        outReader,
        opts.stdoutTailBytes ?? HEADLESS_DEFAULT_STDOUT_TAIL_BYTES,
      ),
      readAll(
        errReader,
        opts.stderrTailBytes ?? HEADLESS_DEFAULT_STDERR_TAIL_BYTES,
      ),
      proc.exited,
    ]);
    // A killed process has no meaningful exit code; the timedOut flag is the
    // signal the caller acts on, so normalize the code to null on timeout.
    return {
      code: timedOut ? null : code,
      stdout: stdout.text,
      stderr: stderr.text,
      timedOut,
      stdoutTruncated: stdout.truncated,
      stdoutTailStartsAtLineBoundary:
        stdout.precedingByte === undefined || stdout.precedingByte === 0x0a,
    };
  } finally {
    clearTimeout(timer);
  }
};

// Drain a process stream while retaining only a fixed-size byte tail.
// A cancel() (on timeout) makes the pending read resolve/reject. Tail mode uses a
// ring buffer, so arbitrary machine-event volume cannot grow verdict-path memory.
async function readAll(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  tailLimitBytes: number,
): Promise<{
  text: string;
  truncated: boolean;
  precedingByte?: number;
}> {
  // Preserve a leading UTF-8 BOM as U+FEFF so raw event-size enforcement still
  // counts its three bytes. unwrapClaudeStream removes it only for JSON parsing.
  const decoder = new TextDecoder("utf-8", { ignoreBOM: true });
  const limit = Number.isFinite(tailLimitBytes)
    ? Math.max(0, Math.floor(tailLimitBytes))
    : 0;
  // One extra byte records whether the bounded tail begins at a JSONL record
  // boundary without changing the caller-visible retention cap. Grow the ring
  // only as output arrives, avoiding a fixed 16 MiB allocation for small runs.
  const maximumTailBytes = limit + 1;
  let tail = new Uint8Array();
  let tailSize = 0;
  let tailWrite = 0;
  const ensureCapacity = (additionalBytes: number): void => {
    const required = Math.min(maximumTailBytes, tailSize + additionalBytes);
    if (required <= tail.byteLength) {
      return;
    }
    let grownBytes = Math.max(1, tail.byteLength);
    while (grownBytes < required && grownBytes < maximumTailBytes) {
      grownBytes = Math.min(maximumTailBytes, grownBytes * 2);
    }
    const grown = new Uint8Array(grownBytes);
    if (tailSize > 0) {
      if (tailSize < tail.byteLength || tailWrite === 0) {
        grown.set(tail.subarray(0, tailSize));
      } else {
        const first = tail.subarray(tailWrite);
        grown.set(first);
        grown.set(tail.subarray(0, tailWrite), first.byteLength);
      }
    }
    tail = grown;
    tailWrite = tailSize;
  };
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value === undefined) continue;
      ensureCapacity(value.byteLength);
      if (value.byteLength >= tail.byteLength) {
        tail.set(value.subarray(value.byteLength - tail.byteLength));
        tailSize = tail.byteLength;
        tailWrite = 0;
      } else if (value.byteLength > 0) {
        const first = Math.min(value.byteLength, tail.byteLength - tailWrite);
        tail.set(value.subarray(0, first), tailWrite);
        if (first < value.byteLength) {
          tail.set(value.subarray(first), 0);
        }
        tailWrite = (tailWrite + value.byteLength) % tail.byteLength;
        tailSize = Math.min(tail.byteLength, tailSize + value.byteLength);
      }
    }
  } catch {
    // Reader was cancelled (timeout) or the stream errored — return the partial
    // buffer; the caller distinguishes success from timeout via the timedOut flag.
  } finally {
    try {
      reader.releaseLock();
    } catch {
      // Already released by cancel(); ignore.
    }
  }
  if (tailSize === 0) {
    return { text: "", truncated: false };
  }
  let chronological: Uint8Array;
  if (tailSize < tail.byteLength || tailWrite === 0) {
    chronological = tail.slice(0, tailSize);
  } else {
    chronological = new Uint8Array(tailSize);
    const first = tail.subarray(tailWrite);
    chronological.set(first);
    chronological.set(tail.subarray(0, tailWrite), first.byteLength);
  }
  const truncated = chronological.byteLength > limit;
  const retained = truncated
    ? chronological.subarray(1)
    : chronological;
  return {
    text: decoder.decode(retained),
    truncated,
    ...(truncated ? { precedingByte: chronological[0] } : {}),
  };
}

// An isolated CODEX_HOME for one codex leg: the env that points codex at it, plus
// a teardown that removes the throwaway home (which holds only copies + codex's
// own throwaway state, so the real ~/.codex is never touched).
export interface CodexHome {
  env: Record<string, string>;
  cleanup: () => Promise<void>;
  diagnostics?: string[];
  // Production isolated homes are safe temporary directories. Observable mode
  // hands this exact path to its wrapper so a parent interruption cannot delete
  // CODEX_HOME while the bounded child is still using it.
  observableCleanupPath?: string;
}

export interface ReviewerCwd {
  path: string;
  cleanup: () => Promise<void>;
  observableCleanupPath?: string;
}

export interface HeadlessBackendDeps {
  run: HeadlessRun;
  mkdir: (path: string) => Promise<void>;
  rm: (path: string) => Promise<void>;
  writeFile: (path: string, content: string) => Promise<void>;
  readFile: (path: string) => Promise<string | undefined>;
  sleep: (ms: number) => Promise<void>;
  tmpDir: string;
  // Base wall-clock bounds. `timeoutMs` keeps its pre-#107 name for the codex
  // backend/test seam; Claude has its own base because the production defaults
  // now differ. Both are scaled by prompt size.
  timeoutMs: number;
  claudeTimeoutMs: number;
  // Poll interval for the observable adapter's completion marker.
  pollIntervalMs: number;
  // --- size-aware timeout knobs, per leg (#85 codex, #99 claude) ---
  // Cap + per-KB scaling for each leg's size-aware timeout. Both use the same
  // `sizeAwareTimeoutMs` helper but have independent base, cap, and per-KB knobs.
  // The codex fields keep their original (#85) names — `timeoutMs`,
  // `maxTimeoutMs`, and `timeoutPerKbMs` — so this exported deps shape stays
  // backward-compatible; the Claude leg uses explicitly-prefixed fields.
  maxTimeoutMs: number;
  timeoutPerKbMs: number;
  claudeMaxTimeoutMs: number;
  claudeTimeoutPerKbMs: number;
  // Bounded retry for a transient codex failure (exit-1 / empty verdict).
  codexRetries: number;
  codexRetryBaseMs: number;
  // Give each production Codex leg its own sanitized CODEX_HOME so concurrent
  // legs never contend on shared mutable state or inherit ambient customizations.
  // The boolean remains an injected test seam; production always enables it.
  isolateCodexHome: boolean;
  prepareCodexHome: () => Promise<CodexHome>;
  // A private per-leg working directory prevents project-instruction discovery
  // from falling back to a shared, attacker-plantable path under /tmp.
  prepareReviewerCwd: (parentDir?: string) => Promise<ReviewerCwd>;
  // One-line operational notices (for example, retry progress). stderr in
  // production; captured in tests.
  warn: (message: string) => void;
  // Injectable FS/time/id seams for the observable adapter. The
  // process runner is always this deps object's `run`, preserving the existing
  // model/auth environment and the headless test boundary.
  observable?: Partial<ObservableAdapterDeps>;
}

function defaultDeps(): HeadlessBackendDeps {
  return {
    run: defaultHeadlessRun,
    mkdir: (path) => mkdir(path, { recursive: true }).then(() => undefined),
    rm: (path) => rm(path, { force: true }).then(() => undefined),
    writeFile: (path, content) => Bun.write(path, content).then(() => undefined),
    readFile: async (path) => {
      const file = Bun.file(path);
      return (await file.exists()) ? file.text() : undefined;
    },
    sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    tmpDir: "/tmp/wux-review",
    timeoutMs: envInt(
      "WUX_REVIEW_CODEX_TIMEOUT_MS",
      envInt("WUX_REVIEW_TIMEOUT_MS", DEFAULT_CODEX_TIMEOUT_MS),
    ),
    claudeTimeoutMs: envInt(
      "WUX_REVIEW_CLAUDE_TIMEOUT_MS",
      envInt("WUX_REVIEW_TIMEOUT_MS", DEFAULT_CLAUDE_TIMEOUT_MS),
    ),
    pollIntervalMs: 1000,
    // Per-leg size-aware knobs. Precedence: the leg-specific var wins, else the
    // leg-agnostic pair (raise both legs with one var), else the per-leg default.
    // The existing WUX_REVIEW_CODEX_* vars keep working unchanged (#85), and the
    // Claude leg gains its own WUX_REVIEW_CLAUDE_* pair (#99). The codex leg's deps
    // fields keep their original names (maxTimeoutMs/timeoutPerKbMs).
    maxTimeoutMs: envInt("WUX_REVIEW_CODEX_MAX_TIMEOUT_MS", envInt("WUX_REVIEW_MAX_TIMEOUT_MS", DEFAULT_CODEX_MAX_TIMEOUT_MS)),
    timeoutPerKbMs: envInt(
      "WUX_REVIEW_CODEX_TIMEOUT_PER_KB_MS",
      envInt("WUX_REVIEW_TIMEOUT_PER_KB_MS", DEFAULT_CODEX_TIMEOUT_PER_KB_MS),
    ),
    claudeMaxTimeoutMs: envInt(
      "WUX_REVIEW_CLAUDE_MAX_TIMEOUT_MS",
      envInt("WUX_REVIEW_MAX_TIMEOUT_MS", DEFAULT_CLAUDE_MAX_TIMEOUT_MS),
    ),
    claudeTimeoutPerKbMs: envInt(
      "WUX_REVIEW_CLAUDE_TIMEOUT_PER_KB_MS",
      envInt("WUX_REVIEW_TIMEOUT_PER_KB_MS", DEFAULT_CLAUDE_TIMEOUT_PER_KB_MS),
    ),
    codexRetries: envInt("WUX_REVIEW_CODEX_RETRIES", DEFAULT_CODEX_RETRIES),
    codexRetryBaseMs: envInt("WUX_REVIEW_CODEX_RETRY_BASE_MS", DEFAULT_CODEX_RETRY_BASE_MS),
    isolateCodexHome: true,
    prepareCodexHome: prepareIsolatedCodexHome,
    prepareReviewerCwd: prepareReviewerCwd,
    warn: (message) => {
      process.stderr.write(`${message}\n`);
    },
  };
}

// Auth env vars codex can authenticate from without an on-disk auth.json. When
// one is set it is inherited into the isolated leg via {...process.env}, so the
// leg can run isolated even with no auth.json to copy (CI / batch hosts).
const CODEX_AUTH_ENV_VARS = ["OPENAI_API_KEY", "CODEX_API_KEY", "CODEX_ACCESS_TOKEN"];

function hasCodexAuthEnv(providerAuthEnvVars: string[]): boolean {
  return [...CODEX_AUTH_ENV_VARS, ...providerAuthEnvVars]
    .some((name) => (process.env[name] ?? "").trim() !== "");
}

type TomlRecord = Record<string, unknown>;

function isTomlRecord(value: unknown): value is TomlRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function pickCodexModelConfig(source: TomlRecord): TomlRecord {
  const safe: TomlRecord = {};
  for (const key of CODEX_MODEL_CONFIG_KEYS) {
    if (source[key] !== undefined) safe[key] = source[key];
  }
  return safe;
}

// Convert the allowlisted object back to TOML without ever interpolating a key
// as syntax. Quoted keys keep custom provider names/header names inert.
function tomlValue(value: unknown): string {
  if (typeof value === "string") return JSON.stringify(value);
  if (typeof value === "boolean") return String(value);
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  if (value instanceof Date) return JSON.stringify(value.toISOString());
  if (Array.isArray(value)) return `[${value.map(tomlValue).join(", ")}]`;
  if (isTomlRecord(value)) {
    return `{ ${Object.entries(value)
      .map(([key, child]) => `${JSON.stringify(key)} = ${tomlValue(child)}`)
      .join(", ")} }`;
  }
  throw new Error("unsupported TOML value in Codex model configuration");
}

function stringifyToml(source: TomlRecord): string {
  const lines: string[] = [];
  const writeTable = (table: TomlRecord, path: string[]) => {
    if (path.length > 0) {
      if (lines.length > 0) lines.push("");
      lines.push(`[${path.map((part) => JSON.stringify(part)).join(".")}]`);
    }
    for (const [key, value] of Object.entries(table)) {
      if (!isTomlRecord(value)) lines.push(`${JSON.stringify(key)} = ${tomlValue(value)}`);
    }
    for (const [key, value] of Object.entries(table)) {
      if (isTomlRecord(value)) writeTable(value, [...path, key]);
    }
  };
  writeTable(source, []);
  return lines.length === 0 ? "" : `${lines.join("\n")}\n`;
}

interface SanitizedCodexConfig {
  content: string;
  providerAuthEnvVars: string[];
  diagnostics: string[];
}

function sanitizeParsedCodexConfig(parsed: TomlRecord): SanitizedCodexConfig {
  const safe = pickCodexModelConfig(parsed);
  if (typeof parsed.profile === "string") safe.profile = parsed.profile;
  const providerAuthEnvVars: string[] = [];
  if (isTomlRecord(parsed.model_providers)) {
    safe.model_providers = parsed.model_providers;
    for (const provider of Object.values(parsed.model_providers)) {
      if (!isTomlRecord(provider)) continue;
      const envKey = provider.env_key;
      if (typeof envKey === "string" && /^[A-Za-z_][A-Za-z0-9_]*$/.test(envKey)) {
        providerAuthEnvVars.push(envKey);
      }
    }
  }
  if (isTomlRecord(parsed.profiles)) {
    const profiles: TomlRecord = {};
    for (const [name, profile] of Object.entries(parsed.profiles)) {
      if (isTomlRecord(profile)) profiles[name] = pickCodexModelConfig(profile);
    }
    safe.profiles = profiles;
  }
  return {
    content: stringifyToml(safe),
    providerAuthEnvVars: [...new Set(providerAuthEnvVars)],
    diagnostics: [],
  };
}

export function sanitizeCodexConfig(raw: string): string {
  return sanitizeParsedCodexConfig(Bun.TOML.parse(raw) as TomlRecord).content;
}

// Bun's TOML parser currently rejects TOML 1.0 date/time literals that Codex's
// Rust parser accepts. Quote simple assignment literals and retry so unrelated
// allowlisted provider/model settings survive. If recovery still fails, return
// an empty generated config: containment wins without turning a harmless ambient
// config syntax difference into a Codex outage.
function sanitizeCodexConfigForLeg(
  raw: string,
  fileName = "config.toml",
): SanitizedCodexConfig {
  const displayName = JSON.stringify(fileName);
  try {
    return sanitizeParsedCodexConfig(Bun.TOML.parse(raw) as TomlRecord);
  } catch (error) {
    const detail = errorDetail(error) || "unknown TOML parse error";
    const datetimeAssignment = /^(\s*(?:[A-Za-z0-9_-]+|"[^"]+"|'[^']+')\s*=\s*)(\d{4}-\d{2}-\d{2}(?:[Tt ]\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:[Zz]|[+-]\d{2}:\d{2})?)?|\d{2}:\d{2}:\d{2}(?:\.\d+)?)(\s*(?:#.*)?)$/gm;
    const recovered = raw.replace(
      datetimeAssignment,
      (_line, prefix: string, value: string, suffix: string) =>
        `${prefix}${JSON.stringify(value)}${suffix}`,
    );
    try {
      const sanitized = sanitizeParsedCodexConfig(Bun.TOML.parse(recovered) as TomlRecord);
      sanitized.diagnostics.push(
        `codex reviewer: ignored unsupported date/time values while sanitizing ${displayName} (${detail})`,
      );
      return sanitized;
    } catch {
      return {
        content: "",
        providerAuthEnvVars: [],
        diagnostics: [
          `codex reviewer: ignored unparseable ${displayName} and generated a minimal config (${detail})`,
        ],
      };
    }
  }
}

async function codexConfigSeedFiles(source: string): Promise<string[]> {
  let entries: Dirent[];
  try {
    entries = await readdir(source, { withFileTypes: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
  return entries
    // Dotfile managers commonly symlink profile layers. Following those links
    // is safe here because the opened target must be a bounded regular file and
    // its bytes are always parsed through the same allowlist below, never copied
    // verbatim into the reviewer home.
    .filter((entry) => {
      const supportedType = entry.isFile() || entry.isSymbolicLink();
      return supportedType && /^.+\.config\.toml$/.test(entry.name);
    })
    .map((entry) => entry.name)
    .sort();
}

interface CodexConfigRead {
  content?: string;
  skipReason?: string;
}

async function readBoundedCodexConfig(path: string): Promise<CodexConfigRead> {
  // O_NONBLOCK prevents opening a FIFO from stalling setup before the reviewer
  // timeout exists. Stat and read the same opened target so a symlink swap cannot
  // replace a validated regular file with a device between those operations.
  const file = await open(path, fsConstants.O_RDONLY | fsConstants.O_NONBLOCK);
  try {
    const metadata = await file.stat();
    if (!metadata.isFile()) {
      return { skipReason: "resolved target is not a regular file" };
    }
    if (metadata.size > MAX_CODEX_CONFIG_BYTES) {
      return {
        skipReason: `resolved target exceeds the ${MAX_CODEX_CONFIG_BYTES}-byte setup limit`,
      };
    }

    const buffer = Buffer.allocUnsafe(MAX_CODEX_CONFIG_BYTES + 1);
    let length = 0;
    while (length < buffer.length) {
      const { bytesRead } = await file.read(
        buffer,
        length,
        buffer.length - length,
        length,
      );
      if (bytesRead === 0) break;
      length += bytesRead;
    }
    if (length > MAX_CODEX_CONFIG_BYTES) {
      return {
        skipReason: `resolved target exceeds the ${MAX_CODEX_CONFIG_BYTES}-byte setup limit`,
      };
    }
    return { content: buffer.subarray(0, length).toString("utf8") };
  } finally {
    await file.close();
  }
}

// Build an isolated CODEX_HOME for one Codex leg. auth.json remains an
// independent mode-0600 copy, while config.toml and <name>.config.toml layers are
// reduced to model/provider selection only. No shared-home fallback is safe:
// setup failure must block the leg rather than re-enable hooks, MCP, plugins,
// skills, or notify commands.
export async function prepareIsolatedCodexHome(): Promise<CodexHome> {
  const source = resolve(process.env.CODEX_HOME ?? join(homedir(), ".codex"));
  let createdHome: string | undefined;
  try {
    createdHome = await mkdtemp(join(tmpdir(), "wuxr-codex-home-"));
    await chmod(createdHome, 0o700);
  } catch (error) {
    if (createdHome !== undefined) {
      await rm(createdHome, { recursive: true, force: true }).catch(() => undefined);
    }
    throw new WuxReviewError(
      `codex reviewer: cannot create secure per-leg CODEX_HOME: ${errorDetail(error)}`,
    );
  }
  const home = createdHome;
  const cleanup = async () => {
    // The home holds only copies + codex's own throwaway state, so removing it
    // cannot touch the user's real ~/.codex.
    await rm(home, { recursive: true, force: true }).catch(() => undefined);
  };
  try {
    let copiedAuth = false;
    const providerAuthEnvVars: string[] = [];
    const diagnostics: string[] = [];
    for (const file of CODEX_HOME_SEED_FILES) {
      const target = join(source, file);
      if (!(await Bun.file(target).exists())) {
        continue;
      }
      await copyFile(target, join(home, file));
      if (file === "auth.json") {
        // The copied token stays as locked-down as the original; the dir is 0700.
        await chmod(join(home, file), 0o600);
        copiedAuth = true;
      }
    }
    const configFiles = ["config.toml", ...await codexConfigSeedFiles(source)];
    for (const fileName of configFiles) {
      const sourceConfig = join(source, fileName);
      let configRead: CodexConfigRead;
      try {
        configRead = await readBoundedCodexConfig(sourceConfig);
      } catch (error) {
        if (fileName === "config.toml") {
          if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
          throw error;
        }
        diagnostics.push(
          `codex reviewer: skipped unreadable named profile ${JSON.stringify(fileName)} ` +
            `(${errorDetail(error)})`,
        );
        continue;
      }
      if (configRead.skipReason !== undefined) {
        diagnostics.push(
          `codex reviewer: skipped ${fileName === "config.toml" ? "config" : "named profile"} ` +
            `${JSON.stringify(fileName)} (${configRead.skipReason})`,
        );
        continue;
      }
      const sanitized = sanitizeCodexConfigForLeg(
        configRead.content ?? "",
        fileName,
      );
      providerAuthEnvVars.push(...sanitized.providerAuthEnvVars);
      diagnostics.push(...sanitized.diagnostics);
      const configPath = join(home, fileName);
      await Bun.write(configPath, sanitized.content);
      await chmod(configPath, 0o600);
    }
    // Auth-route detection is advisory, not part of the isolation boundary.
    // An unauthenticated local/OSS provider is valid, and Codex itself gives the
    // authoritative error when a remote route genuinely lacks credentials.
    // Either way the leg stays in this sanitized home; it never loads the shared
    // user home merely because this preflight could not prove an auth route.
    if (!copiedAuth && !hasCodexAuthEnv(providerAuthEnvVars)) {
      diagnostics.push(
        "codex reviewer: no auth route detected in the isolated setup " +
          "(no auth.json, built-in auth variable, or preserved provider env_key); " +
          "proceeding so Codex can validate authentication or use an unauthenticated provider",
      );
    }
    return {
      env: { CODEX_HOME: home },
      cleanup,
      diagnostics,
      observableCleanupPath: home,
    };
  } catch (error) {
    await cleanup();
    if (error instanceof WuxReviewError) throw error;
    throw new WuxReviewError(
      `codex reviewer: cannot prepare secure per-leg CODEX_HOME: ${errorDetail(error)}`,
    );
  }
}

export async function prepareReviewerCwd(parentDir = tmpdir()): Promise<ReviewerCwd> {
  let createdPath: string | undefined;
  try {
    createdPath = await mkdtemp(join(parentDir, "wuxr-reviewer-cwd-"));
    await chmod(createdPath, 0o700);
  } catch (error) {
    if (createdPath !== undefined) {
      await rm(createdPath, { recursive: true, force: true }).catch(() => undefined);
    }
    throw new WuxReviewError(
      `reviewer: cannot create secure per-leg working directory: ${errorDetail(error)}`,
    );
  }
  const path = createdPath;
  return {
    path,
    cleanup: async () => {
      await rm(path, { recursive: true, force: true }).catch(() => undefined);
    },
    observableCleanupPath: path,
  };
}

// Execute a leg's unchanged argv through the strict observable adapter when
// selected by the caller, or directly for the explicit rollback. Observable failures
// fail closed: there is no fallback to direct execution and therefore no
// ambiguity about whether durable evidence/result validation actually happened.
interface ExecLegInput {
  argv: string[];
  stdin?: string;
  prompt: string;
  timeoutMs: number;
  reviewer: ReviewerName;
  attempt?: number;
  outputPath?: string;
  cleanupFiles?: string[];
  cleanupDir?: string;
  recordEvidence?: BackendOptions["recordEvidence"];
  env?: Record<string, string>;
  cwd: string;
}

async function execLeg(
  deps: HeadlessBackendDeps,
  opts: BackendOptions,
  input: ExecLegInput,
): Promise<HeadlessRunResult> {
  const cwd = input.cwd;
  if (opts.direct !== true) {
    const attempt = input.attempt ?? 1;
    const childName = attempt === 1 ? opts.sessionName : `${opts.sessionName}-a${attempt}`;
    const recordPreparedChild = opts.recordPreparedChild;
    return runObservableLeg(
      {
        childName,
        reviewId: opts.reviewId ?? opts.sessionName,
        round: opts.round ?? 1,
        reviewer: input.reviewer,
        attempt,
        prompt: input.prompt,
        argv: input.argv,
        stdin: input.stdin,
        cwd,
        timeoutMs: input.timeoutMs,
        env: input.env,
        outputPath: input.outputPath,
        cleanupFiles: input.cleanupFiles,
        cleanupDir: input.cleanupDir,
        recordPrepared: recordPreparedChild === undefined
          ? undefined
          : () => recordPreparedChild(childName, attempt),
        recordEvidence: input.recordEvidence ?? opts.recordEvidence,
        signal: opts.signal,
      },
      {
        ...deps.observable,
        run: deps.run,
        pollIntervalMs: deps.observable?.pollIntervalMs ?? deps.pollIntervalMs,
      },
    );
  }
  return deps.run(input.argv, {
    stdin: input.stdin,
    cwd,
    timeoutMs: input.timeoutMs,
    env: input.env,
    stdoutTailBytes: input.reviewer === "claude"
      ? HEADLESS_DEFAULT_STDOUT_TAIL_BYTES
      : 0,
    stderrTailBytes: HEADLESS_DEFAULT_STDERR_TAIL_BYTES,
  });
}

// The Claude leg: `claude -p --output-format stream-json --verbose`, prompt
// (with the diff) fed on stdin so a large diff never hits an argv limit and the
// model never reads a truncated file. It remains one bounded headless call. The
// stream's final result event is unwrapped only after process completion; in
// observable mode that final event crosses the validated atomic result boundary
// while the full raw stream remains chunked evidence and the live renderer
// remains evidence-only.
export function createClaudeHeadlessBackend(overrides: Partial<HeadlessBackendDeps> = {}): Backend {
  const deps = { ...defaultDeps(), ...overrides };
  // Before per-leg bases existed, injected `timeoutMs` controlled both backends.
  // Preserve that test/API seam unless the caller explicitly supplies the new
  // Claude-specific field. Production (no overrides) uses the resolved per-leg
  // environment/default value from defaultDeps().
  const baseTimeoutMs = overrides.claudeTimeoutMs ?? overrides.timeoutMs ?? deps.claudeTimeoutMs;

  return async (prompt: string, opts: BackendOptions): Promise<string> => {
    const promptPath = `${tempPathBase(deps.tmpDir, opts.sessionName)}-prompt.md`;
    let reviewerCwd: ReviewerCwd | undefined;
    let observableEvidenceRecorded = false;
    let observableCleanupTransferred = false;
    await deps.mkdir(deps.tmpDir);
    try {
      // Write inside the cleanup scope: a partial write (e.g. disk full) must
      // never leave the diff-bearing prompt file lingering in the temp dir.
      await deps.writeFile(promptPath, prompt);
      const args = [
        "claude",
        "-p",
        "--output-format",
        "stream-json",
        "--verbose",
        "--safe-mode",
        "--tools",
        "",
        "--strict-mcp-config",
        "--disable-slash-commands",
        "--no-session-persistence",
        "--settings",
        "{}",
      ];
      if (opts.model) {
        args.push("--model", opts.model);
      }
      // Large diffs (read whole, before the model's first turn) earn proportionally
      // more wall-clock; a genuine overrun still surfaces as a typed timeout naming
      // the size and the env lever (#99). This is the same size-aware helper the
      // codex leg uses — the Claude leg previously used a flat bound, so a large
      // diff died at the 240s default with no verdict.
      const promptBytes = Buffer.byteLength(prompt);
      const timeoutMs = sizeAwareTimeoutMs(
        baseTimeoutMs,
        promptBytes,
        deps.claudeTimeoutPerKbMs,
        deps.claudeMaxTimeoutMs,
      );
      deps.warn(timeoutStartMessage("claude", timeoutMs, promptBytes));
      reviewerCwd = await deps.prepareReviewerCwd();
      let result: HeadlessRunResult;
      try {
        result = await execLeg(deps, opts, {
          argv: args,
          stdin: prompt,
          prompt,
          timeoutMs,
          reviewer: "claude",
          cleanupFiles: [promptPath],
          cleanupDir: reviewerCwd.observableCleanupPath,
          recordEvidence: async (evidence) => {
            observableEvidenceRecorded = true;
            await opts.recordEvidence?.(evidence);
          },
          // The diff is already complete on stdin. A fresh private cwd prevents
          // project or attacker-planted instruction discovery without losing input.
          cwd: reviewerCwd.path,
        });
      } catch (error) {
        observableCleanupTransferred = opts.direct !== true
          && opts.signal?.aborted === true
          && opts.signal.reason === "parent-interrupted"
          && observableEvidenceRecorded
          && error instanceof ObservableLifecycleError
          && error.state === "interrupted";
        throw error;
      }
      if (result.timedOut) {
        const message = timeoutMessage("claude", timeoutMs, promptBytes, deps.claudeMaxTimeoutMs);
        throw opts.direct !== true
          ? new ObservableLifecycleError(message, "timed_out")
          : new WuxReviewError(message);
      }
      if (result.code !== 0) {
        // Machine-event stdout can contain prompt/diff/tool/reasoning payloads.
        // Never echo it into a user-facing error; stderr or the exit code is
        // enough to diagnose the failed process safely.
        const detail = oneLine(result.stderr) || `exit ${result.code}`;
        throw new WuxReviewError(`claude reviewer: claude -p failed: ${detail}`);
      }
      const stdoutMayBeTruncated = result.stdoutTruncated
        ?? Buffer.byteLength(result.stdout)
          === HEADLESS_DEFAULT_STDOUT_TAIL_BYTES;
      return unwrapClaudeStream(
        result.stdout,
        stdoutMayBeTruncated
          && result.stdoutTailStartsAtLineBoundary !== true,
      );
    } finally {
      const wrapperOwnsInterruptedCleanup = opts.direct !== true
        && observableCleanupTransferred;
      if (!wrapperOwnsInterruptedCleanup) {
        await reviewerCwd?.cleanup();
        await deps.rm(promptPath);
      }
    }
  };
}

// Find the final Claude result event without treating any lifecycle/tool event
// as verdict data. Malformed and unknown earlier events are ignored here (the
// observable capture diagnoses and retains them); without one valid final result
// event the leg fails closed and can never approve.
export function unwrapClaudeStream(
  stdout: string,
  discardPartialFirstLine = false,
): string {
  if (discardPartialFirstLine) {
    const firstNewline = stdout.indexOf("\n");
    stdout = firstNewline === -1 ? "" : stdout.slice(firstNewline + 1);
  }
  let end = stdout.length;
  while (end > 0) {
    const newline = stdout.lastIndexOf("\n", end - 1);
    const line = stdout.slice(newline + 1, end);
    end = newline;
    if (line.trim() === "") {
      continue;
    }
    // CRLF's CR is framing, not part of the JSON event size budget.
    const jsonLine = line.endsWith("\r") ? line.slice(0, -1) : line;
    const jsonForParsing = jsonLine.startsWith("\uFEFF")
      ? jsonLine.slice(1)
      : jsonLine;
    let value: unknown;
    try {
      value = JSON.parse(jsonForParsing);
    } catch {
      continue;
    }
    if (isClaudeResultEvent(value)) {
      if (Buffer.byteLength(jsonLine) > MACHINE_RESULT_EVENT_LIMIT_BYTES) {
        throw new WuxReviewError(
          "claude reviewer: final stream-json result exceeded the 16 MiB limit",
        );
      }
      return unwrapClaudeResult(value);
    }
  }
  throw new WuxReviewError(
    "claude reviewer: stream-json output contained no final result event",
  );
}

// The stream's final result envelope carries the model answer in `.result`,
// gated by an explicit success flag. A failure envelope (or a permission denial
// that silently dropped the diff) is a typed error, never a silent empty review.
function unwrapClaudeResult(data: Record<string, unknown>): string {
  const env = data as {
    is_error?: unknown;
    subtype?: unknown;
    result?: unknown;
    api_error_status?: unknown;
    permission_denials?: unknown;
  };
  // Fail closed on the canonical success flag: require an explicit
  // `is_error === false` to proceed, so a missing/non-boolean `is_error` (an
  // unexpected or future envelope shape) is treated as a failure rather than
  // silently approved. We deliberately do NOT also require `subtype === "success"`,
  // so a future success-equivalent subtype is not misclassified; the result is
  // independently validated downstream (parseReport requires a real JSON findings
  // block), so a malformed success can never become a silent approval either.
  if (env.is_error !== false) {
    const detail = stringOr(env.api_error_status) ?? stringOr(env.subtype) ?? "unknown error";
    throw new WuxReviewError(`claude reviewer: claude -p reported failure (${detail})`);
  }
  if (Array.isArray(env.permission_denials) && env.permission_denials.length > 0) {
    throw new WuxReviewError(
      `claude reviewer: claude -p was blocked by ${env.permission_denials.length} permission denial(s)`,
    );
  }
  if (typeof env.result !== "string" || env.result.trim() === "") {
    throw new WuxReviewError("claude reviewer: claude -p returned an empty result");
  }
  return env.result;
}

// The Codex leg: `codex exec` run headless, read-only, and bounded. The prompt
// (with the diff) is written to a temp file; codex is told to read that brief and
// emit only the findings block, which it writes to a `-o` last-message file we
// then read. Writing the diff to a file (rather than inlining it in argv)
// sidesteps the codex-exec inline-diff hang, and reading the verdict from `-o` is
// deterministic: codex exec *exits* when the turn completes, so there is no TUI,
// no instruction pasted into one, and no sentinel polling — just a bounded
// subprocess.
export function createCodexHeadlessBackend(overrides: Partial<HeadlessBackendDeps> = {}): Backend {
  const deps = { ...defaultDeps(), ...overrides };

  return async (prompt: string, opts: BackendOptions): Promise<string> => {
    const base = tempPathBase(deps.tmpDir, opts.sessionName);
    const promptPath = `${base}-prompt.md`;
    const outPath = `${base}-last.txt`;
    let home: CodexHome | undefined;
    let reviewerCwd: ReviewerCwd | undefined;
    let observableEvidenceRecorded = false;
    let observableCleanupTransferred = false;
    // Large diffs (read whole, before codex's first turn) earn proportionally more
    // wall-clock; a genuine overrun still surfaces as a typed timeout (#85).
    const promptBytes = Buffer.byteLength(prompt);
    const timeoutMs = sizeAwareTimeoutMs(deps.timeoutMs, promptBytes, deps.timeoutPerKbMs, deps.maxTimeoutMs);
    deps.warn(timeoutStartMessage("codex", timeoutMs, promptBytes, true));
    // Isolation + retry are transport-independent. Candidate observable attempts
    // receive the same isolated CODEX_HOME env and each retry gets its own durable
    // child/evidence identity; no extra invocation is introduced.
    const isolate = deps.isolateCodexHome;
    const maxRetries = deps.codexRetries;
    await deps.mkdir(deps.tmpDir);
    try {
      await deps.writeFile(promptPath, prompt);
      // Give the leg its own sanitized CODEX_HOME. Production always takes this
      // path; the false branch is retained only for injected unit-test seams and
      // explicitly ignores shared user config.
      if (isolate) {
        home = await deps.prepareCodexHome();
        for (const diagnostic of home.diagnostics ?? []) deps.warn(diagnostic);
      }
      try {
        // Nest Codex's private cwd inside its throwaway home so observable mode
        // can transfer one cleanup root to the wrapper on parent interruption.
        reviewerCwd = await deps.prepareReviewerCwd(home?.observableCleanupPath);
        // `--ephemeral`: never persist this one-shot review's session to disk.
        // Pure upside — it drops the per-event session-rollout writes that
        // concurrent legs would otherwise serialize on in a shared CODEX_HOME.
        const args = [
          "codex",
          "exec",
          "--json",
          "-s",
          "read-only",
          "--skip-git-repo-check",
          "--ephemeral",
          "--ignore-rules",
          "-C",
          reviewerCwd.path,
          "-o",
          outPath,
        ];
        if (opts.model) {
          args.push("-m", opts.model);
        }
        args.push(
          `Read the review brief at ${promptPath} and follow it exactly. ` +
            `Output ONLY the single JSON findings block it specifies — no prose before or after.`,
        );

        if (!isolate) {
          args.splice(2, 0, "--ignore-user-config");
        }
        for (let attempt = 0; ; attempt++) {
          // Clear any stale last-message (from a prior run reusing this session
          // name, or a prior attempt) so a failed attempt can't read an old verdict.
          await deps.rm(outPath);
          let result: HeadlessRunResult;
          try {
            result = await execLeg(deps, opts, {
              argv: args,
              prompt,
              timeoutMs,
              reviewer: "codex",
              attempt: attempt + 1,
              outputPath: outPath,
              cleanupFiles: [promptPath, outPath],
              cleanupDir: home?.observableCleanupPath
                ?? reviewerCwd.observableCleanupPath,
              recordEvidence: async (evidence) => {
                observableEvidenceRecorded = true;
                await opts.recordEvidence?.(evidence);
              },
              env: home?.env,
              cwd: reviewerCwd.path,
            });
          } catch (error) {
            observableCleanupTransferred = opts.direct !== true
              && opts.signal?.aborted === true
              && opts.signal.reason === "parent-interrupted"
              && observableEvidenceRecorded
              && error instanceof ObservableLifecycleError
              && error.state === "interrupted";
            throw error;
          }
          // A timeout is the wall-clock bound doing its job; retrying only doubles
          // the wait, so surface it as a typed error immediately (never retried).
          if (result.timedOut) {
            const message = timeoutMessage("codex", timeoutMs, promptBytes, deps.maxTimeoutMs);
            throw opts.direct !== true
              ? new ObservableLifecycleError(message, "timed_out")
              : new WuxReviewError(message);
          }
          // In observable mode, result.json is the only verdict
          // source. The adapter has already copied and validated Codex's `-o`
          // output into `structuredOutput`; never reach around that contract to
          // read the temporary output file directly.
          const last = result.code === 0
            ? opts.direct !== true
              ? result.structuredOutput
              : await deps.readFile(outPath)
            : undefined;
          if (result.code === 0 && last !== undefined && last.trim() !== "") {
            if (attempt > 0) {
              deps.warn(`codex reviewer: recovered on attempt ${attempt + 1}/${maxRetries + 1}`);
            }
            return last;
          }
          // Transient failure: a non-zero exit (the eval's `exit-1`) or an empty
          // verdict. Retry with exponential backoff so a flake never loses a
          // verdict; once attempts are spent, surface a typed error with the count.
          const nonZero = result.code !== 0;
          // JSONL stdout can contain commands, tool payloads, model text, and
          // reasoning summaries. It is durable evidence, not a safe diagnostic.
          const detail = nonZero ? oneLine(result.stderr) || `exit ${result.code}` : "produced no final message";
          if (attempt >= maxRetries) {
            const suffix = attempt > 0 ? ` after ${attempt + 1} attempts` : "";
            throw new WuxReviewError(
              nonZero
                ? `codex reviewer: codex exec failed${suffix}: ${detail}`
                : `codex reviewer: codex exec produced no final message${suffix}`,
            );
          }
          const backoffMs = deps.codexRetryBaseMs * 2 ** attempt;
          deps.warn(`codex reviewer: ${detail}; retrying (attempt ${attempt + 2}/${maxRetries + 1}) in ${backoffMs}ms`);
          await deps.sleep(backoffMs);
        }
      } finally {
        const cleanupPath = home?.observableCleanupPath
          ?? reviewerCwd?.observableCleanupPath;
        const wrapperOwnsInterruptedCleanup = opts.direct !== true
          && observableCleanupTransferred
          && cleanupPath !== undefined;
        if (!wrapperOwnsInterruptedCleanup) {
          await reviewerCwd?.cleanup();
          await home?.cleanup();
        }
      }
    } finally {
      // Both the diff-bearing prompt and the verdict file are removed on every
      // exit path — neither should linger in the temp dir.
      const wrapperOwnsInterruptedCleanup = opts.direct !== true
        && observableCleanupTransferred;
      if (!wrapperOwnsInterruptedCleanup) {
        await deps.rm(promptPath);
        await deps.rm(outPath);
      }
    }
  };
}

// Guard the session name before it is interpolated into temp-file paths. The
// production caller validates the session id, but the backend must not trust a
// distant invariant: a name containing "/" or ".." could otherwise let the
// cleanup rm() (or the prompt write) escape the temp dir. Fail closed on
// anything but a safe slug, and return the shared path stem for this session.
function tempPathBase(tmpDir: string, sessionName: string): string {
  if (!/^[A-Za-z0-9_-]+$/.test(sessionName)) {
    throw new WuxReviewError(`invalid reviewer session name: ${JSON.stringify(sessionName)}`);
  }
  return `${tmpDir}/${sessionName}`;
}

function stringOr(value: unknown): string | undefined {
  return typeof value === "string" && value !== "" ? value : undefined;
}
