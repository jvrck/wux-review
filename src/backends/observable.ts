import { appendFile, mkdir, open, rename, rm, writeFile } from "node:fs/promises";
import { createHash, createHmac, randomBytes, randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { basename, dirname, isAbsolute, join, resolve, sep } from "node:path";
import { z } from "zod";
import { errorDetail, oneLine, WuxReviewError } from "../runtime/errors";
import { observableRetryAttempt } from "../review/observable-attempt";
import type {
  LegExecutionEvidence,
  ObservableControlEvent,
  ObservableLifecycleState,
  ReviewerName,
} from "../review/types";
import {
  initialObservablePaneState,
  renderObservablePane,
  type ObservablePaneState,
} from "../review/observable-render";
import { REVIEWER_STDERR_TAIL_BYTES } from "./capture-limits";
import {
  MACHINE_EVENT_PARSE_LIMIT_BYTES,
  MACHINE_EVENT_READ_CHUNK_BYTES,
  MachineEventParser,
  machineStreamChunkRecord,
  type ParsedMachineEvent,
} from "./observable-events";

const WUX_COMMAND_TIMEOUT_MS = 30 * 1000;
const DEFAULT_POLL_INTERVAL_MS = 1000;
const TIMEOUT_MARKER = "__WUX_REVIEW_TIMEOUT__";
const WRAPPER_TIMEOUT_GRACE_MS = 250;
const RELEASE_MARKER_REAP_MS = 60 * 1000;
// The parent's 4s synchronous acknowledgement window deliberately covers the
// wrapper's 2.1s final pane-flush delay plus scheduler/filesystem jitter. If it
// expires, terminal flow still reaps the exact child before transient cleanup
// removes this result generation's release markers.
const RELEASE_ACK_POLLS = 80;
// Nine liveness checks over the same ~4s production window as the former 80 x
// 50ms fixed cadence, without spawning a Wux subprocess every 50ms.
const CHILD_REAP_BACKOFF_MULTIPLIERS = [1, 2, 4, 8, 16, 16, 16, 16] as const;
const WUX_PROBE_ATTEMPTS = 3;
const WUX_LIVENESS_PROBE_INTERVAL_MS = 5 * 1000;
const WUX_EVENT_LINE_LIMIT_BYTES = 1024 * 1024;
const MACHINE_STREAM_EVIDENCE_FILE = "machine-stream.jsonl";
const WUX_ALREADY_GONE_PATTERNS = [
  /^run not found:/i,
  /^run is not running(?:\s|$)/i,
  /^run is (?:already )?stopped(?::|$)/i,
  /^tmux session is not running(?:\s|$)/i,
  /^no such session(?:\s|$)/i,
  /^unknown session(?:\s|$)/i,
];
export const OBSERVABLE_DRAIN_READS_PER_PASS = 64;

export interface ObservableRunOptions {
  stdin?: string;
  cwd?: string;
  timeoutMs: number;
  env?: Record<string, string>;
}

export interface ObservableRunResult {
  code: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
}

export type ObservableRun = (cmd: string[], opts: ObservableRunOptions) => Promise<ObservableRunResult>;

export interface ObservableAdapterDeps {
  run: ObservableRun;
  mkdir: (path: string) => Promise<void>;
  rm: (path: string) => Promise<void>;
  writeFile: (path: string, content: string) => Promise<void>;
  writePrivateFile: (path: string, content: string) => Promise<void>;
  readFile: (path: string) => Promise<string | undefined>;
  snapshotSize: (path: string) => Promise<number | undefined>;
  readChunk: (path: string, offset: number, maxBytes: number) => Promise<Uint8Array>;
  appendFile: (path: string, content: string) => Promise<void>;
  rename: (from: string, to: string) => Promise<void>;
  sleep: (ms: number) => Promise<void>;
  scheduleRm: (path: string, delayMs: number) => void;
  now: () => string;
  resultId: () => string;
  cleanupKey: () => string;
  renderPane: (state: ObservablePaneState, at?: string) => string;
  tmpDir: string;
  pollIntervalMs: number;
}

export interface ObservableLegInput {
  childName: string;
  reviewId: string;
  round: number;
  reviewer: ReviewerName;
  attempt: number;
  prompt: string;
  argv: string[];
  stdin?: string;
  cwd: string;
  timeoutMs: number;
  env?: Record<string, string>;
  outputPath?: string;
  cleanupFiles?: string[];
  cleanupDir?: string;
  recordPrepared?: () => void | Promise<void>;
  recordEvidence?: (evidence: LegExecutionEvidence) => void | Promise<void>;
  signal?: AbortSignal;
}

export interface ObservableLegResult extends ObservableRunResult {
  structuredOutput?: string;
}

export interface ReconcileObservableLegInput {
  reviewId: string;
  round: number;
  evidence: LegExecutionEvidence;
}

const statusListSchema = z.array(z.object({
  name: z.string(),
  status: z.string(),
}).passthrough());
const launchSchema = z.object({
  name: z.string(),
  backend: z.literal("shell"),
}).passthrough();
const readSchema = z.object({
  name: z.string(),
  runDir: z.string(),
}).passthrough();
const preparedCleanupSchema = z.object({
  version: z.literal(1),
  childName: z.string(),
  cleanupFiles: z.array(z.string()),
  cleanupDir: z.string().optional(),
}).strict();
const resultSchema = z.object({
  version: z.literal(1),
  identity: z.object({
    id: z.string().min(1),
    reviewId: z.string().min(1),
    round: z.number().int().positive(),
    reviewer: z.enum(["claude", "codex"]),
    childName: z.string().min(1),
    attempt: z.number().int().positive(),
    promptSha256: z.string().regex(/^[0-9a-f]{64}$/),
  }).strict(),
  process: z.object({
    code: z.number().int(),
    stdout: z.string(),
    stderr: z.string(),
    timedOut: z.literal(false),
  }).strict(),
  output: z.string().optional(),
}).strict();

type ObservableResultFile = z.infer<typeof resultSchema>;

interface ObservableLifecycleFile {
  version: 1;
  identity: ObservableResultFile["identity"];
  state: ObservableLifecycleState;
  startedAt: string;
  updatedAt: string;
  diagnostic?: string;
  controls?: ObservableControlEvent[];
}

export class ObservableLifecycleError extends WuxReviewError {
  constructor(
    message: string,
    readonly state: ObservableLifecycleState,
    readonly evidencePath?: string,
    readonly cleanupPending = false,
  ) {
    super(message);
  }
}

export function defaultObservableDeps(run: ObservableRun): ObservableAdapterDeps {
  return {
    run,
    mkdir: (path) => mkdir(path, { recursive: true }).then(() => undefined),
    rm: (path) => rm(path, { recursive: true, force: true }).then(() => undefined),
    writeFile: (path, content) => Bun.write(path, content).then(() => undefined),
    writePrivateFile: (path, content) => writeFile(path, content, {
      encoding: "utf8",
      flag: "wx",
      mode: 0o600,
    }),
    readFile: async (path) => {
      const file = Bun.file(path);
      return (await file.exists()) ? file.text() : undefined;
    },
    snapshotSize: readFileSnapshotSize,
    readChunk: readFileChunk,
    appendFile: (path, content) => appendFile(path, content, "utf8"),
    rename,
    sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    scheduleRm: scheduleFileRemoval,
    now: () => new Date().toISOString(),
    resultId: randomUUID,
    cleanupKey: () => randomBytes(32).toString("hex"),
    renderPane: renderObservablePane,
    tmpDir: "/tmp/wux-review",
    pollIntervalMs: DEFAULT_POLL_INTERVAL_MS,
  };
}

class WuxControlScanner {
  private offset = 0;
  private readonly prefixHash = createHash("sha256");
  private prefixSha256 = createHash("sha256").digest("hex");
  private pending: Uint8Array = new Uint8Array();
  private sawCreate = false;
  private invalid = false;
  private expectedPrefixVerified = false;
  private authenticatedOwnedCleanup = false;
  private latestSend: ObservableControlEvent | undefined;
  readonly controls: ObservableControlEvent[] = [];

  constructor(
    private readonly childName: string,
    private readonly resultId: string,
    private readonly now: () => string,
    private readonly ownedCleanupKey?: string,
    private readonly expectedPrefix?: LegExecutionEvidence["eventPrefix"],
  ) {}

  async scan(
    deps: Pick<ObservableAdapterDeps, "snapshotSize" | "readChunk">,
    eventsPath: string,
  ): Promise<ObservableControlEvent[]> {
    const snapshot = (await deps.snapshotSize(eventsPath)) ?? 0;
    if (
      this.offset === 0
      && this.expectedPrefix !== undefined
      && !this.expectedPrefixVerified
      && (
        !Number.isSafeInteger(this.expectedPrefix.bytes)
        || this.expectedPrefix.bytes <= 0
        || !/^[0-9a-f]{64}$/.test(this.expectedPrefix.sha256)
        || snapshot < this.expectedPrefix.bytes
      )
    ) {
      this.invalidate();
      return this.controls;
    }
    if (snapshot < this.offset) {
      this.invalidate();
      return this.controls;
    }
    if (this.offset > 0) {
      const actualPrefix = createHash("sha256");
      let verified = 0;
      while (verified < this.offset) {
        const bytes = await deps.readChunk(
          eventsPath,
          verified,
          Math.min(MACHINE_EVENT_READ_CHUNK_BYTES, this.offset - verified),
        );
        if (bytes.byteLength === 0) {
          this.invalidate();
          return this.controls;
        }
        actualPrefix.update(bytes);
        verified += bytes.byteLength;
      }
      if (actualPrefix.digest("hex") !== this.prefixSha256) {
        this.invalidate();
        return this.controls;
      }
    }
    while (this.offset < snapshot) {
      const readLimit = this.expectedPrefix === undefined
        || this.expectedPrefixVerified
        ? snapshot
        : Math.min(snapshot, this.expectedPrefix.bytes);
      const bytes = await deps.readChunk(
        eventsPath,
        this.offset,
        Math.min(MACHINE_EVENT_READ_CHUNK_BYTES, readLimit - this.offset),
      );
      if (bytes.byteLength === 0) {
        this.invalidate();
        break;
      }
      this.prefixHash.update(bytes);
      this.offset += bytes.byteLength;
      this.consume(bytes);
      if (
        this.expectedPrefix !== undefined
        && !this.expectedPrefixVerified
        && this.offset === this.expectedPrefix.bytes
      ) {
        this.prefixSha256 = this.prefixHash.copy().digest("hex");
        if (this.prefixSha256 !== this.expectedPrefix.sha256) {
          this.invalidate();
          return this.controls;
        }
        this.expectedPrefixVerified = true;
      }
    }
    this.prefixSha256 = this.prefixHash.copy().digest("hex");
    return this.controls;
  }

  assertBaseline(): void {
    if (!this.sawCreate) {
      this.invalidate();
    }
  }

  assertComplete(): void {
    if (this.pending.byteLength > 0) {
      this.invalidate();
    }
  }

  checkpoint(): NonNullable<LegExecutionEvidence["eventPrefix"]> {
    return {
      bytes: this.offset,
      sha256: this.prefixSha256,
    };
  }

  hasAuthenticatedOwnedCleanup(): boolean {
    return this.authenticatedOwnedCleanup;
  }

  async findOwnedStopSince(
    deps: Pick<ObservableAdapterDeps, "snapshotSize" | "readChunk">,
    eventsPath: string,
    offset: number,
    cleanupActor: string,
  ): Promise<{ at: string; by: string } | undefined> {
    const snapshot = await deps.snapshotSize(eventsPath);
    if (
      snapshot === undefined
      || snapshot <= offset
      || snapshot - offset > WUX_EVENT_LINE_LIMIT_BYTES
    ) {
      return undefined;
    }
    let cursor = offset;
    let added: Uint8Array = new Uint8Array();
    while (cursor < snapshot) {
      const bytes = await deps.readChunk(
        eventsPath,
        cursor,
        Math.min(MACHINE_EVENT_READ_CHUNK_BYTES, snapshot - cursor),
      );
      if (bytes.byteLength === 0) return undefined;
      added = concat(added, bytes);
      cursor += bytes.byteLength;
    }
    if (added[added.byteLength - 1] !== 0x0a) return undefined;
    const matches: Array<{ at: string; by: string }> = [];
    let start = 0;
    for (let index = 0; index < added.byteLength; index++) {
      if (added[index] !== 0x0a) continue;
      const event = this.decodeEventLine(added.subarray(start, index));
      if (event === undefined) return undefined;
      if (
        event !== null
        && event.type === "stop"
        && event.run === this.childName
        && typeof event.at === "string"
        && typeof event.by === "string"
        && event.by.startsWith(`${cleanupActor}@`)
      ) {
        matches.push({ at: event.at, by: event.by });
      }
      start = index + 1;
    }
    return matches.length === 1 ? matches[0] : undefined;
  }

  private consume(bytes: Uint8Array): void {
    let start = 0;
    for (let index = 0; index < bytes.byteLength; index++) {
      if (bytes[index] !== 0x0a) continue;
      this.consumeLine(concat(this.pending, bytes.subarray(start, index)));
      this.pending = new Uint8Array();
      start = index + 1;
    }
    if (start < bytes.byteLength) {
      this.pending = concat(this.pending, bytes.subarray(start));
      if (this.pending.byteLength > WUX_EVENT_LINE_LIMIT_BYTES) {
        this.invalidate();
        this.pending = new Uint8Array();
      }
    }
  }

  private consumeLine(bytes: Uint8Array): void {
    const event = this.decodeEventLine(bytes);
    if (event === null) return;
    if (event === undefined) {
      this.invalidate();
      return;
    }
    if (event.type === "create") {
      if (this.sawCreate) this.invalidate();
      this.sawCreate = true;
      return;
    }
    if (!this.sawCreate || typeof event.type !== "string") {
      this.invalidate();
      return;
    }
    // A later reconciliation creates a fresh scanner, so the durable marker
    // must distinguish a prior wux-review exact-child stop from an operator
    // stop in the same released Wux log. The marker follows a successful Wux
    // stop and removes only that immediately preceding control. Every marker
    // must independently authenticate; a redundant authenticated marker with no
    // new stop is an idempotent no-op, while an unauthenticated marker taints.
    if (event.type === "review-leg-owned-cleanup") {
      const authenticated =
        event.resultId === this.resultId
        && typeof event.stopAt === "string"
        && typeof event.stopBy === "string"
        && typeof event.proof === "string"
        && this.ownedCleanupKey !== undefined
        && event.proof === ownedCleanupProof(
          this.ownedCleanupKey,
          this.childName,
          this.resultId,
          event.stopAt,
          event.stopBy,
        );
      if (!authenticated) {
        this.invalidate();
      } else {
        this.authenticatedOwnedCleanup = true;
        if (
          this.controls.at(-1)?.action === "stop"
          && this.controls.at(-1)?.at === event.stopAt
          && this.controls.at(-1)?.actor === event.stopBy
        ) {
          this.controls.pop();
        }
      }
      return;
    }
    if (!["send", "interrupt", "handoff", "stop"].includes(event.type)) {
      return;
    }
    const fallback = event.type === "handoff" ? this.latestSend : undefined;
    const control: ObservableControlEvent = {
      action: event.type as ObservableControlEvent["action"],
      at: typeof event.at === "string" ? event.at : fallback?.at ?? this.now(),
      actor: typeof event.by === "string" ? event.by : fallback?.actor ?? "unknown",
    };
    this.controls.push(control);
    if (event.type === "send") this.latestSend = control;
  }

  private decodeEventLine(
    bytes: Uint8Array,
  ): Record<string, unknown> | null | undefined {
    if (bytes.byteLength === 0) return null;
    if (bytes.byteLength > WUX_EVENT_LINE_LIMIT_BYTES) return undefined;
    try {
      const value: unknown = JSON.parse(
        new TextDecoder("utf-8", { fatal: true }).decode(bytes),
      );
      if (
        typeof value !== "object"
        || value === null
        || Array.isArray(value)
      ) {
        return undefined;
      }
      const event = value as Record<string, unknown>;
      return event.run === undefined || event.run === this.childName
        ? event
        : undefined;
    } catch {
      return undefined;
    }
  }

  private invalidate(): void {
    if (this.invalid) return;
    this.invalid = true;
    this.controls.push({
      action: "invalid-events",
      at: this.now(),
      actor: "unknown",
    });
  }
}

function ownedCleanupProof(
  key: string,
  childName: string,
  resultId: string,
  stopAt: string,
  stopBy: string,
): string {
  return createHmac("sha256", key)
    .update("wux-review-owned-cleanup\0")
    .update(childName)
    .update("\0")
    .update(resultId)
    .update("\0")
    .update(stopAt)
    .update("\0")
    .update(stopBy)
    .digest("hex");
}

// The shell session receives only this bootstrap script path. The reviewer argv
// itself remains NUL-delimited and is reconstructed as a Bash array, so model
// names and other argument values are never evaluated by a shell. A separate
// mode-0600 NUL file reconstructs the direct process environment under `env -i`;
// this is required because an existing tmux server may not inherit the Wux
// client's current PATH/auth/CODEX_HOME. The wrapper waits for the parent to
// discover Wux's runDir before starting the model, keeping even a fast fake
// reviewer alive long enough for `wux read --json`.
export function buildObservableWrapperScript(paths: {
  argsPath: string;
  stdoutPath: string;
  stderrPath: string;
  donePath: string;
  readyPath: string;
  panePath?: string;
  releasePath?: string;
  releasedPath?: string;
  stdinPath?: string;
  envPath?: string;
  timeoutPath?: string;
  timeoutMs?: number;
  readyPollLimit?: number;
  releasePollLimit?: number;
  releaseFlushSeconds?: number;
  releaseAckToken?: string;
  releaseAckCleanupPollLimit?: number;
  parentPid?: number;
  watchdogSleepPidPath?: string;
  outputPath?: string;
  recoveryOutputPath?: string;
  cleanupFiles?: string[];
  cleanupDir?: string;
}): string {
  const redir = paths.stdinPath === undefined ? "< /dev/null" : `< ${shq(paths.stdinPath)}`;
  const command = paths.envPath === undefined
    ? '"${__a[@]}"'
    : '/usr/bin/env -i "${__e[@]}" "${__a[@]}"';
  const invoke = command + " " + redir + " > " + shq(paths.stdoutPath) + " 2> " + shq(paths.stderrPath);
  // Wrapper mechanics must not depend on the reviewer's PATH. The direct path
  // accepts an absolute reviewer argv under a deliberately restricted PATH, so
  // observable mode must still be able to sleep and atomically publish markers.
  // A simple-command PATH assignment is scoped to that helper invocation and
  // never changes the environment reconstructed for the reviewer below.
  const helper = "PATH=/usr/bin:/bin";
  const releaseAckToken = paths.releaseAckToken ?? "released";
  const timedInvoke = paths.timeoutPath === undefined || paths.timeoutMs === undefined
    ? [invoke, "__rc=$?"]
    : [
        "set -m",
        `${invoke} &`,
        "__pid=$!",
        "(",
        `  ${helper} sleep ${(Math.max(0, paths.timeoutMs) / 1000).toFixed(3)} &`,
        "  __sleep=$!",
        ...(paths.watchdogSleepPidPath === undefined
          ? []
          : [`  printf %s "$__sleep" > ${shq(paths.watchdogSleepPidPath)}`]),
        '  wait "$__sleep" 2>/dev/null || exit 0',
        '  if kill -0 -- "-$__pid" 2>/dev/null; then',
        `    printf %s ${shq(TIMEOUT_MARKER)} > ${shq(`${paths.timeoutPath}.tmp`)}`,
        `    ${helper} mv ${shq(`${paths.timeoutPath}.tmp`)} ${shq(paths.timeoutPath)}`,
        '    kill -TERM -- "-$__pid" 2>/dev/null || true',
        `    ${helper} sleep 0.25`,
        '    kill -KILL -- "-$__pid" 2>/dev/null || true',
        "  fi",
        ") &",
        "__watch=$!",
        'wait "$__pid"',
        "__rc=$?",
        `if [ -s ${shq(paths.timeoutPath)} ]; then`,
        '  wait "$__watch" 2>/dev/null || true',
        `  __rc=${shq(TIMEOUT_MARKER)}`,
        "else",
        // With job control enabled, the watchdog and its child `sleep` own a
        // separate process group. Kill the whole group on early reviewer
        // completion so the timer cannot leak until the full timeout.
        '  kill -TERM -- "-$__watch" 2>/dev/null || true',
        '  wait "$__watch" 2>/dev/null || true',
        "fi",
        "set +m",
      ];
  const pane = paths.panePath === undefined
    ? []
    : [
        `${helper} tail -n +1 -F ${shq(paths.panePath)} 2>/dev/null &`,
        "__pane=$!",
        '__stop_pane() { kill "$__pane" 2>/dev/null || true; wait "$__pane" 2>/dev/null || true; }',
        "trap __stop_pane EXIT",
      ];
  const preserveOutput = paths.outputPath === undefined || paths.recoveryOutputPath === undefined
    ? []
    : [
        `if [ -f ${shq(paths.outputPath)} ]; then`,
        `  ${helper} cp ${shq(paths.outputPath)} ${shq(`${paths.recoveryOutputPath}.tmp`)}`,
        `  ${helper} mv ${shq(`${paths.recoveryOutputPath}.tmp`)} ${shq(paths.recoveryOutputPath)}`,
        "fi",
      ];
  const cleanup = paths.cleanupDir === undefined && (paths.cleanupFiles?.length ?? 0) === 0
    ? []
    : [
        ...(paths.panePath === undefined ? ["__stop_pane() { :; }"] : []),
        "__cleanup_observable() {",
        "  __stop_pane",
        ...(paths.parentPid === undefined
          ? []
          : [
              `  if kill -0 -- ${Math.max(1, Math.floor(paths.parentPid))} 2>/dev/null; then return; fi`,
            ]),
        ...(paths.cleanupFiles ?? []).map((path) => `  ${helper} rm -f -- ${shq(path)}`),
        ...(paths.cleanupDir === undefined
          ? []
          : [`  ${helper} rm -rf -- ${shq(paths.cleanupDir)}`]),
        "}",
        "trap __cleanup_observable EXIT",
      ];
  const parentGuard = [
    `  if [ ! -e ${shq(paths.argsPath)} ]; then exit 126; fi`,
    ...(paths.parentPid === undefined
      ? []
      : [
          `  if ! kill -0 -- ${Math.max(1, Math.floor(paths.parentPid))} 2>/dev/null; then exit 126; fi`,
        ]),
  ];
  const release = paths.releasePath === undefined || paths.releasedPath === undefined
    ? []
    : [
        // Once the bounded reviewer process has exited, keep the pane follower
        // alive until the parent finishes its finite snapshot and publishes the
        // final pane. Tests may inject a poll limit to exercise abandoned-parent
        // cleanup, but production has no size-dependent 10s truncation window.
        ...(paths.releasePollLimit === undefined
          ? [
              `while [ ! -e ${shq(paths.releasePath)} ]; do`,
              ...parentGuard,
              `  ${helper} sleep 0.05`,
              "done",
            ]
          : [
              "__release_waits=0",
              `while [ ! -e ${shq(paths.releasePath)} ] && [ "$__release_waits" -lt ${Math.max(0, Math.floor(paths.releasePollLimit))} ]; do`,
              ...parentGuard,
              `  ${helper} sleep 0.05`,
              "  __release_waits=$((__release_waits + 1))",
              "done",
            ]),
        // Give tail two polls after the final snapshot is appended before the
        // shell exits and its EXIT trap terminates the pane follower.
        `if [ -e ${shq(paths.releasePath)} ]; then`,
        `  ${helper} sleep ${Math.max(0, paths.releaseFlushSeconds ?? 2.1).toFixed(3)}`,
        `  if [ -e ${shq(paths.releasePath)} ]; then`,
        `    printf %s ${shq(releaseAckToken)} > ${shq(`${paths.releasedPath}.tmp`)}`,
        `    ${helper} mv ${shq(`${paths.releasedPath}.tmp`)} ${shq(paths.releasedPath)}`,
        `    ${helper} rm -f ${shq(paths.releasePath)}`,
        // Keep the acknowledgement available through the parent's bounded wait,
        // then self-clean it after bootstrap teardown or a finite fallback.
        "    __ack_waits=0",
        `    while [ -e ${shq(paths.argsPath)} ] && [ "$__ack_waits" -lt ${Math.max(0, Math.floor(paths.releaseAckCleanupPollLimit ?? 120))} ]; do`,
        ...(paths.parentPid === undefined
          ? []
          : [
              `      if ! kill -0 -- ${Math.max(1, Math.floor(paths.parentPid))} 2>/dev/null; then break; fi`,
            ]),
        `      ${helper} sleep 0.05`,
        "      __ack_waits=$((__ack_waits + 1))",
        "    done",
        `    ${helper} rm -f ${shq(paths.releasedPath)}`,
        "  fi",
        "fi",
      ];
  return [
    "#!/usr/bin/env bash",
    "set -uo pipefail",
    "__waits=0",
    `while [ ! -s ${shq(paths.readyPath)} ]; do`,
    `  if [ ! -e ${shq(paths.argsPath)} ]; then exit 125; fi`,
    `  if [ "$__waits" -ge ${Math.max(0, Math.floor(paths.readyPollLimit ?? 600))} ]; then`,
    `    printf %s 125 > ${shq(`${paths.donePath}.tmp`)}`,
    `    ${helper} mv ${shq(`${paths.donePath}.tmp`)} ${shq(paths.donePath)}`,
    "    exit 125",
    "  fi",
    `  ${helper} sleep 0.05`,
    "  __waits=$((__waits + 1))",
    "done",
    "__a=()",
    'while IFS= read -r -d "" __x || [ -n "$__x" ]; do __a+=("$__x"); done < ' + shq(paths.argsPath),
    ...(paths.envPath === undefined
      ? []
      : [
          "__e=()",
          'while IFS= read -r -d "" __x || [ -n "$__x" ]; do __e+=("$__x"); done < ' + shq(paths.envPath),
        ]),
    ...pane,
    ...cleanup,
    ...timedInvoke,
    ...preserveOutput,
    'printf %s "$__rc" > ' + shq(`${paths.donePath}.tmp`),
    `${helper} mv ${shq(`${paths.donePath}.tmp`)} ${shq(paths.donePath)}`,
    ...release,
    "",
  ].join("\n");
}

export async function runObservableLeg(
  input: ObservableLegInput,
  overrides: Partial<ObservableAdapterDeps> = {},
): Promise<ObservableLegResult> {
  validateChildName(input.childName);
  const deps: ObservableAdapterDeps = {
    ...defaultObservableDeps(overrides.run ?? defaultUnavailableRun),
    ...overrides,
  };
  if (input.signal?.aborted) {
    const parent = input.signal.reason === "parent-interrupted";
    throw new ObservableLifecycleError(
      parent
        ? `${input.childName} observable reviewer leg interrupted before launch`
        : `${input.childName} observable reviewer leg cancelled before launch after its sibling failed`,
      parent ? "interrupted" : "failed",
    );
  }
  const base = tempPathBase(deps.tmpDir, input.childName);
  const argsPath = `${base}-observable-args`;
  const envPath = `${base}-observable-env`;
  const stdinPath = `${base}-observable-stdin`;
  const stdoutPath = `${base}-observable-stdout`;
  const stderrPath = `${base}-observable-stderr`;
  const donePath = `${base}-observable-done`;
  const timeoutPath = `${base}-observable-timeout`;
  const readyPath = `${base}-observable-ready`;
  const panePath = `${base}-observable-pane`;
  const resultId = deps.resultId();
  const ownedCleanupKey = deps.cleanupKey();
  // Release handshakes are generation-specific. A detached TTL reaper from an
  // abandoned prior same-name leg must never target a later leg's fresh marker.
  const { releasePath, releasedPath } = releasePathsForBase(base, resultId);
  const recoveryOutputPath = codexOutputPath(base);
  const preparedCleanupPath = `${base}-observable-prepared-cleanup.json`;
  const scriptPath = `${base}-observable.sh`;
  const transientPaths = transientPathsForBase(base, {
    releasePath,
    releasedPath,
  });
  validateObservableCleanup(input.cleanupFiles, input.cleanupDir, deps.tmpDir);

  await deps.mkdir(deps.tmpDir);
  let launched = false;
  let evidencePath: string | undefined;
  let evidence: LegExecutionEvidence | undefined;
  let identity: ObservableResultFile["identity"] | undefined;
  let paneState: ObservablePaneState | undefined;
  let scanner: WuxControlScanner | undefined;
  let wrapperExitedNormally = false;
  let lifecycleState: ObservableLifecycleState = "pending";
  let startedAt = deps.now();
  const publishTerminalState = async (args: {
    state: ObservableLifecycleState;
    diagnostic: string;
    controls?: ObservableControlEvent[];
    updatePane?: boolean;
    recordEvent?: boolean;
  }): Promise<void> => {
    if (evidencePath === undefined || identity === undefined) return;
    const at = deps.now();
    await publishLifecycle(deps, evidencePath, {
      version: 1,
      identity,
      state: args.state,
      startedAt,
      updatedAt: at,
      diagnostic: args.diagnostic,
      ...(args.controls === undefined || args.controls.length === 0
        ? {}
        : { controls: args.controls }),
    }).catch(() => undefined);
    if (paneState !== undefined && args.updatePane !== false) {
      paneState.status = args.state === "timed_out"
        ? "timed-out"
        : args.state === "pending"
          ? "failed"
          : args.state;
      paneState.phase = "failed";
      paneState.latestActivity = args.state === "tainted"
        ? "external control detected"
        : "reviewer leg failed";
      paneState.updatedAt = at;
      paneState.lastActivityAt = at;
      await publishObservation(deps, evidencePath, panePath, paneState)
        .catch(() => undefined);
    }
    if (args.recordEvent !== false) {
      await appendEvent(deps, evidencePath, {
        type: `review-leg-${args.state}`,
        at,
        run: input.childName,
        reviewer: input.reviewer,
        resultId,
        ...(args.controls === undefined || args.controls.length === 0
          ? {}
          : { controls: args.controls }),
      }).catch(() => undefined);
    }
  };
  try {
    await assertNoCollision(deps, input.childName, input.env);
    // Wux reports no live owner for this deterministic base, so clear remnants
    // from an interrupted earlier leg before publishing this run's bootstrap.
    await Promise.all(transientPaths.map((path) => deps.rm(path).catch(() => undefined)));
    await deps.writePrivateFile(
      preparedCleanupPath,
      `${JSON.stringify({
        version: 1,
        childName: input.childName,
        cleanupFiles: input.cleanupFiles ?? [],
        ...(input.cleanupDir === undefined
          ? {}
          : { cleanupDir: input.cleanupDir }),
      })}\n`,
    );
    // The parent journal must own this exact attempt before any launchable
    // bootstrap is published. Cleanup metadata is already durable here, so a
    // crash after the checkpoint but before Wux launch is safely reclaimable.
    await input.recordPrepared?.();
    await deps.writeFile(argsPath, encodeNulRecords(input.argv));
    await deps.writePrivateFile(envPath, serializeEnvironment(input.env));
    if (input.stdin !== undefined) {
      await deps.writeFile(stdinPath, input.stdin);
    }
    await deps.writeFile(
      scriptPath,
      buildObservableWrapperScript({
        argsPath,
        stdoutPath,
        stderrPath,
        donePath,
        readyPath,
        panePath,
        releasePath,
        releasedPath,
        stdinPath: input.stdin === undefined ? undefined : stdinPath,
        envPath,
        timeoutPath,
        timeoutMs: input.timeoutMs,
        outputPath: input.outputPath,
        recoveryOutputPath: input.outputPath === undefined ? undefined : recoveryOutputPath,
        cleanupFiles: input.cleanupFiles,
        cleanupDir: input.cleanupDir,
        releaseAckToken: resultId,
        parentPid: process.pid,
      }),
    );
    const launch = await runWux(
      deps,
      [
        "wux",
        "--local",
        "run",
        "shell",
        "--name",
        input.childName,
        "--cwd",
        input.cwd,
        "--json",
        "--",
        "-c",
        `exec /bin/bash ${shq(scriptPath)}`,
      ],
      input.env,
    );
    if (launch.timedOut || launch.code !== 0) {
      throw legError(input.childName, `wux run shell failed: ${detailOf(launch)}`);
    }
    let launchData: unknown;
    try {
      launchData = JSON.parse(launch.stdout);
    } catch {
      throw legError(input.childName, "invalid wux run --json response");
    }
    const parsedLaunch = launchSchema.safeParse(launchData);
    if (!parsedLaunch.success || parsedLaunch.data.name !== input.childName) {
      throw legError(input.childName, "invalid wux run --json response");
    }
    launched = true;

    evidencePath = await discoverRunDir(deps, input.childName, input.env);
    const promptSha256 = createHash("sha256").update(input.prompt).digest("hex");
    const resultPath = join(evidencePath, "result.json");
    identity = {
      id: resultId,
      reviewId: input.reviewId,
      round: input.round,
      reviewer: input.reviewer,
      childName: input.childName,
      attempt: input.attempt,
      promptSha256,
    };
    evidence = {
      reviewer: input.reviewer,
      childName: input.childName,
      attempt: input.attempt,
      evidencePath,
      resultPath,
      resultId,
      promptSha256,
      transientBase: base,
      ownedCleanupKey,
      ...(input.cleanupFiles === undefined
        ? {}
        : { cleanupFiles: [...input.cleanupFiles] }),
      ...(input.cleanupDir === undefined ? {} : { cleanupDir: input.cleanupDir }),
    };

    await deps.writeFile(join(evidencePath, "prompt.md"), input.prompt);
    startedAt = deps.now();
    paneState = initialObservablePaneState({
      reviewId: input.reviewId,
      round: input.round,
      reviewer: input.reviewer,
      attempt: input.attempt,
      childName: input.childName,
      resultId,
      at: startedAt,
    });
    await publishLifecycle(deps, evidencePath, {
      version: 1,
      identity,
      state: "pending",
      startedAt,
      updatedAt: startedAt,
    });
    await appendEvent(deps, evidencePath, {
      type: "review-leg-start",
      at: startedAt,
      run: input.childName,
      reviewer: input.reviewer,
      reviewId: input.reviewId,
      round: input.round,
      attempt: input.attempt,
      resultId,
      promptSha256,
    });
    await publishObservation(deps, evidencePath, panePath, paneState);
    await input.recordEvidence?.(evidence);
    scanner = new WuxControlScanner(
      input.childName,
      resultId,
      deps.now,
      ownedCleanupKey,
    );
    await scanner.scan(deps, join(evidencePath, "events.jsonl"));
    scanner.assertBaseline();
    assertUntainted(input.childName, evidencePath, scanner.controls);
    evidence = { ...evidence, eventPrefix: scanner.checkpoint() };
    await input.recordEvidence?.(evidence);
    await deps.writeFile(readyPath, `${evidencePath}\n`);
    const runningAt = deps.now();
    lifecycleState = "running";
    await publishLifecycle(deps, evidencePath, {
      version: 1,
      identity,
      state: lifecycleState,
      startedAt,
      updatedAt: runningAt,
    });
    paneState.status = "running";
    paneState.phase = "initializing";
    paneState.latestActivity = "reviewer started";
    paneState.updatedAt = runningAt;
    paneState.lastActivityAt = runningAt;
    await publishObservation(deps, evidencePath, panePath, paneState);

    const parser = new MachineEventParser(input.reviewer);
    let streamOffset = 0;
    let marker: string | undefined;
    let waited = 0;
    // discoverRunDir just proved this exact child live, so wait one full probe
    // interval before asking Wux for the same information again.
    let nextLivenessProbeAt = WUX_LIVENESS_PROBE_INTERVAL_MS;
    for (;;) {
      throwIfAborted(input, evidencePath);
      const drained = await drainMachineStream(
        deps,
        evidencePath,
        stdoutPath,
        input.reviewer,
        streamOffset,
        parser,
        paneState,
      );
      streamOffset = drained.offset;
      const observedAt = deps.now();
      paneState.updatedAt = observedAt;
      await publishObservation(deps, evidencePath, panePath, paneState);

      marker = await deps.readFile(donePath);
      if (marker !== undefined && marker.trim() !== "") {
        break;
      }
      if (waited >= nextLivenessProbeAt) {
        const live = await probeChild(deps, input.childName, evidencePath, input.env);
        if (!live) {
          throw new ObservableLifecycleError(
            `${input.childName} observable reviewer leg: child disappeared before publishing a process result; evidence: ${evidencePath}`,
            "failed",
            evidencePath,
          );
        }
        nextLivenessProbeAt = waited + WUX_LIVENESS_PROBE_INTERVAL_MS;
      }
      if (waited >= input.timeoutMs + Math.max(WRAPPER_TIMEOUT_GRACE_MS, deps.pollIntervalMs)) {
        const stdoutSnapshotBytes = (await deps.snapshotSize(stdoutPath)) ?? 0;
        await finishMachineSnapshot(
          deps,
          evidencePath,
          stdoutPath,
          input.reviewer,
          streamOffset,
          parser,
          paneState,
          stdoutSnapshotBytes,
        );
        lifecycleState = "timed_out";
        const result = await finishTimedOutLeg({
          deps,
          input,
          evidencePath,
          panePath,
          paneState,
          identity,
          startedAt,
          resultId,
          ownedCleanupKey,
          scanner,
          transientPaths,
          diagnostic: "parent timeout expired before the child completion marker",
        });
        return result;
      }
      await deps.sleep(deps.pollIntervalMs);
      waited += deps.pollIntervalMs;
    }

    // Wux controls cannot influence pane rendering or verdict parsing directly.
    // Scan once at the completed process boundary (and again after release/stop)
    // instead of repeatedly rereading an ever-growing event prefix on every
    // long-running poll.
    await scanner.scan(deps, join(evidencePath, "events.jsonl"));
    assertUntainted(input.childName, evidencePath, scanner.controls);

    // Freeze one byte-exact regular-file boundary after the process marker.
    // Chunked reads drain arbitrarily large finite output without allocating
    // the whole capture or following a stdout-inheriting grandchild forever.
    const stdoutSnapshotBytes = (await deps.snapshotSize(stdoutPath)) ?? 0;
    await finishMachineSnapshot(
      deps,
      evidencePath,
      stdoutPath,
      input.reviewer,
      streamOffset,
      parser,
      paneState,
      stdoutSnapshotBytes,
    );

    if (marker.trim() === TIMEOUT_MARKER) {
      lifecycleState = "timed_out";
      const result = await finishTimedOutLeg({
        deps,
        input,
        evidencePath,
        panePath,
        paneState,
        identity,
        startedAt,
        resultId,
        ownedCleanupKey,
        scanner,
        transientPaths,
        diagnostic: "reviewer process exceeded its timeout",
      });
      return result;
    }

    const code = Number.parseInt(marker.trim(), 10);
    const normalizedCode = Number.isNaN(code) ? 1 : code;
    // Full machine stdout is already durable as byte-exact chunk evidence.
    // Only the bounded final Claude result event is verdict input; Codex keeps
    // its authoritative `-o` final message in `output`.
    const stdout = input.reviewer === "claude"
      ? parser.finalResultEvent() ?? ""
      : "";
    const stderrSnapshotBytes = (await deps.snapshotSize(stderrPath)) ?? 0;
    const stderr = await readTextTail(
      deps,
      stderrPath,
      stderrSnapshotBytes,
      REVIEWER_STDERR_TAIL_BYTES,
    );
    const output = input.outputPath === undefined ? undefined : await deps.readFile(input.outputPath);
    await appendEvent(deps, evidencePath, {
      type: "review-leg-process-result",
      at: deps.now(),
      run: input.childName,
      reviewer: input.reviewer,
      resultId,
      code: normalizedCode,
      stdoutBytes: stdoutSnapshotBytes,
      stderrBytes: stderrSnapshotBytes,
      ...(output === undefined ? {} : { outputBytes: Buffer.byteLength(output) }),
    });
    const collectingAt = deps.now();
    paneState.status = "collecting";
    paneState.phase = "finalizing";
    paneState.latestActivity = "process exited";
    paneState.updatedAt = collectingAt;
    paneState.lastActivityAt = collectingAt;
    paneState.result.code = normalizedCode;
    await publishObservation(deps, evidencePath, panePath, paneState);

    const result: ObservableResultFile = {
      version: 1,
      identity,
      process: { code: normalizedCode, stdout, stderr, timedOut: false },
      ...(output === undefined ? {} : { output }),
    };
    await publishResult(deps, resultPath, result, input.childName);
    await appendEvent(deps, evidencePath, {
      type: "review-leg-result-published",
      at: deps.now(),
      run: input.childName,
      reviewer: input.reviewer,
      resultId,
      resultPath,
    });

    // Read back and validate the atomically-published file. No capture, pane
    // scrape, or temporary output is returned to the verdict parser directly.
    const validated = await readValidatedResult(deps, resultPath, result.identity, input.childName);
    throwIfAborted(input, evidencePath);
    // Publish final process metadata while the wrapper's pane follower is still
    // alive. This is not acceptance: released Wux controls are scanned again
    // after wrapper exit and exact-child cleanup before lifecycle completion.
    const resultObservedAt = deps.now();
    paneState.status = "collecting";
    paneState.phase = "finalizing";
    paneState.latestActivity = "atomic result published";
    paneState.updatedAt = resultObservedAt;
    paneState.lastActivityAt = resultObservedAt;
    paneState.result = {
      state: "final",
      code: validated.process.code,
      timedOut: false,
      resultId,
    };
    await publishObservation(deps, evidencePath, panePath, paneState);
    const releaseAcknowledged = await releaseWrapper(
      deps,
      releasePath,
      releasedPath,
      resultId,
    );
    if (releaseAcknowledged) {
      // The wrapper keeps its acknowledgement available until this bootstrap
      // disappears. Remove it now so the wrapper exits promptly instead of
      // deadlocking against the later all-transient cleanup.
      await deps.rm(argsPath);
      wrapperExitedNormally = await waitForChildExit(
        deps,
        input.childName,
        evidencePath,
        input.env,
      );
    }
    await scanner.scan(deps, join(evidencePath, "events.jsonl"));
    assertUntainted(input.childName, evidencePath, scanner.controls);
    await settleOwnedChild({
      deps,
      scanner,
      childName: input.childName,
      evidencePath,
      resultId,
      env: input.env,
      ownedCleanupKey,
      wrapperExitedNormally,
    });
    evidence = {
      ...evidence,
      eventPrefix: scanner.checkpoint(),
      ...(wrapperExitedNormally ? { wrapperExitedNormally: true } : {}),
    };
    // Persist terminal child proof before returning a successful leg. A parent
    // crash between leg return and round finalization can then reconcile an
    // already-gone wrapper without weakening exact-child authentication.
    await input.recordEvidence?.(evidence);
    const completedAt = deps.now();
    lifecycleState = validated.process.code === 0 ? "completed" : "failed";
    paneState.status = lifecycleState;
    paneState.phase = lifecycleState === "completed" ? "completed" : "failed";
    paneState.latestActivity = lifecycleState === "completed"
      ? "atomic result published"
      : "reviewer leg failed";
    paneState.updatedAt = completedAt;
    paneState.lastActivityAt = completedAt;
    paneState.result = {
      state: "final",
      code: validated.process.code,
      timedOut: false,
      resultId,
    };
    await publishObservation(deps, evidencePath, panePath, paneState);
    // Cleanup is part of the fail-closed candidate boundary, but it must finish
    // before lifecycle completion is published. Publish the final observational
    // pane first so cleanup also removes that last transient write.
    await cleanupTransient(deps, transientPaths);
    await publishLifecycle(deps, evidencePath, {
      version: 1,
      identity,
      state: lifecycleState,
      startedAt,
      updatedAt: completedAt,
      ...(validated.process.code === 0
        ? {}
        : { diagnostic: `reviewer process exited ${validated.process.code}` }),
    });
    return {
      code: validated.process.code,
      stdout: validated.process.stdout,
      stderr: validated.process.stderr,
      timedOut: false,
      structuredOutput: validated.output,
    };
  } catch (caught) {
    let error = caught;
    const interrupted = input.signal?.aborted
      && input.signal.reason === "parent-interrupted";
    if (
      interrupted
      && evidencePath !== undefined
      && identity !== undefined
      && evidence !== undefined
      && scanner !== undefined
    ) {
      try {
        lifecycleState = "interrupted";
        const at = deps.now();
        await publishLifecycle(deps, evidencePath, {
          version: 1,
          identity,
          state: lifecycleState,
          startedAt,
          updatedAt: at,
          diagnostic: "parent interrupted; child and bootstrap evidence retained for reconciliation",
        });
        if (paneState !== undefined) {
          paneState.status = "interrupted";
          paneState.phase = "interrupted";
          paneState.latestActivity = "parent interrupted";
          paneState.updatedAt = at;
          paneState.lastActivityAt = at;
          await publishObservation(deps, evidencePath, panePath, paneState);
        }
        await appendEvent(deps, evidencePath, {
          type: "review-leg-interrupted",
          at,
          run: input.childName,
          reviewer: input.reviewer,
          resultId,
        });
        await scanner.scan(deps, join(evidencePath, "events.jsonl"));
        scanner.assertBaseline();
        scanner.assertComplete();
        assertUntainted(input.childName, evidencePath, scanner.controls);
        evidence = { ...evidence, eventPrefix: scanner.checkpoint() };
        // Recovery is safe only after the authenticated event checkpoint is
        // durably reflected in the round journal.
        await input.recordEvidence?.(evidence);
        throw new ObservableLifecycleError(
          `${input.childName} observable reviewer leg interrupted; reconcile review ${input.reviewId}; evidence: ${evidencePath}`,
          "interrupted",
          evidencePath,
        );
      } catch (checkpointError) {
        if (
          checkpointError instanceof ObservableLifecycleError
          && checkpointError.state === "interrupted"
        ) {
          throw checkpointError;
        }
        error = checkpointError;
      }
    }

    let terminalError = error;
    let state = error instanceof ObservableLifecycleError
      ? error.state
      : lifecycleState === "timed_out"
        ? "timed_out"
        : "failed";
    if (evidencePath !== undefined && identity !== undefined) {
      const controls = error instanceof ObservableLifecycleError && error.state === "tainted"
        ? scanner?.controls
        : undefined;
      await publishTerminalState({
        state,
        diagnostic: errorDetail(error),
        controls,
      });
    }
    let cleanupError: unknown;
    let exactChildInactive = !launched;
    if (launched) {
      const stopped = await stopObservableChild({
        deps,
        childName: input.childName,
        evidencePath,
        resultId,
        env: input.env,
        ownedCleanupKey,
        scanner,
        wrapperExitedNormally,
      });
      exactChildInactive = stopped.inactive;
      cleanupError = stopped.error;
    }
    if (evidencePath !== undefined && scanner !== undefined) {
      try {
        await verifyControlEvidence(
          deps,
          scanner,
          input.childName,
          evidencePath,
        );
      } catch (candidate) {
        if (
          candidate instanceof ObservableLifecycleError
          && candidate.state === "tainted"
        ) {
          terminalError = candidate;
          state = "tainted";
          await publishTerminalState({
            state,
            diagnostic: oneLine(candidate.message),
            controls: scanner.controls,
            recordEvent: false,
          });
        } else {
          cleanupError ??= candidate;
        }
      }
    }
    if (exactChildInactive) {
      try {
        await cleanupTransient(deps, transientPaths);
      } catch (candidate) {
        cleanupError ??= candidate;
      }
    }
    if (cleanupError !== undefined) {
      const diagnostic = `${errorDetail(terminalError)}; terminal cleanup failed: ${errorDetail(cleanupError)}`;
      if (evidencePath !== undefined && identity !== undefined) {
        await publishTerminalState({
          state,
          diagnostic,
          controls: scanner?.controls,
          updatePane: false,
          recordEvent: false,
        });
      }
      throw new ObservableLifecycleError(
        `${input.childName} observable reviewer leg: ${diagnostic}${evidencePath === undefined ? "" : `; evidence: ${evidencePath}`}`,
        state,
        evidencePath,
        true,
      );
    }
    if (terminalError instanceof Error) {
      throw terminalError;
    }
    throw new ObservableLifecycleError(
      `${input.childName} observable reviewer leg: ${errorDetail(terminalError)}${evidencePath === undefined ? "" : `; evidence: ${evidencePath}`}`,
      state,
      evidencePath,
    );
  }
}

export async function reconcileObservableLeg(
  input: ReconcileObservableLegInput,
  overrides: Partial<ObservableAdapterDeps> = {},
): Promise<ObservableLegResult> {
  const record = input.evidence;
  validateChildName(record.childName);
  const deps: ObservableAdapterDeps = {
    ...defaultObservableDeps(overrides.run ?? defaultUnavailableRun),
    ...overrides,
  };
  const base = assertReconcilableIdentity(record, deps, {
    requireEventPrefix: true,
  });
  const identity: ObservableResultFile["identity"] = {
    id: record.resultId,
    reviewId: input.reviewId,
    round: input.round,
    reviewer: record.reviewer,
    childName: record.childName,
    attempt: record.attempt,
    promptSha256: record.promptSha256,
  };
  const prompt = await deps.readFile(join(record.evidencePath, "prompt.md"));
  if (
    prompt === undefined
    || createHash("sha256").update(prompt).digest("hex") !== record.promptSha256
  ) {
    throw legError(
      record.childName,
      "missing or mismatched durable prompt evidence",
      record.evidencePath,
    );
  }
  const lifecycle = await readLifecycle(deps, record.evidencePath, identity);
  if (["timed_out", "tainted"].includes(lifecycle.state)) {
    throw new ObservableLifecycleError(
      `${record.childName} observable reviewer leg is ${lifecycle.state} and cannot be reconciled; evidence: ${record.evidencePath}`,
      lifecycle.state,
      record.evidencePath,
    );
  }
  const scanner = new WuxControlScanner(
    record.childName,
    record.resultId,
    deps.now,
    record.ownedCleanupKey,
    record.eventPrefix,
  );
  await scanner.scan(deps, join(record.evidencePath, "events.jsonl"));
  scanner.assertBaseline();
  if (scanner.controls.length > 0) {
    await discardReconciliationEvidence({
      deps,
      record,
      lifecycle,
      state: "tainted",
      diagnostic: "external control detected during reconciliation",
      controls: scanner.controls,
    });
    assertUntainted(record.childName, record.evidencePath, scanner.controls);
  }

  if (await probeChild(deps, record.childName, record.evidencePath)) {
    throw new ObservableLifecycleError(
      `${record.childName} observable reviewer leg is still running; reconciliation starts no model calls, so retry after it exits; evidence: ${record.evidencePath}`,
      "interrupted",
      record.evidencePath,
    );
  }

  let validated: ObservableResultFile;
  try {
    const resultTmpPath = `${record.resultPath}.tmp`;
    if ((await deps.readFile(resultTmpPath)) !== undefined) {
      await preserveRejectedResult(deps, record.resultPath);
      throw legError(
        record.childName,
        "partial atomic result.json.tmp",
        record.evidencePath,
      );
    }
    const existing = await deps.readFile(record.resultPath);
    if (existing !== undefined) {
      validated = await readValidatedResult(
        deps,
        record.resultPath,
        identity,
        record.childName,
      );
    } else {
      const donePath = `${base}-observable-done`;
      const marker = await deps.readFile(donePath);
      if (marker === undefined || marker.trim() === "") {
        throw new ObservableLifecycleError(
          `${record.childName} observable reviewer leg disappeared without a completion marker; evidence: ${record.evidencePath}`,
          "failed",
          record.evidencePath,
        );
      }
      if (marker.trim() === TIMEOUT_MARKER) {
        throw new ObservableLifecycleError(
          `${record.childName} observable reviewer leg timed out before parent reconciliation; evidence: ${record.evidencePath}`,
          "timed_out",
          record.evidencePath,
        );
      }
      if (!/^\d+$/.test(marker.trim())) {
        throw new ObservableLifecycleError(
          `${record.childName} observable reviewer leg has a malformed completion marker; evidence: ${record.evidencePath}`,
          "failed",
          record.evidencePath,
        );
      }
      const code = Number.parseInt(marker.trim(), 10);
      if (!Number.isSafeInteger(code)) {
        throw new ObservableLifecycleError(
          `${record.childName} observable reviewer leg has an invalid completion code; evidence: ${record.evidencePath}`,
          "failed",
          record.evidencePath,
        );
      }
      const stdoutPath = `${base}-observable-stdout`;
      const stderrPath = `${base}-observable-stderr`;
      const parser = new MachineEventParser(record.reviewer);
      const stdoutSnapshot = await deps.snapshotSize(stdoutPath);
      if (stdoutSnapshot === undefined) {
        throw new ObservableLifecycleError(
          `${record.childName} observable reviewer leg is missing its machine stream; evidence: ${record.evidencePath}`,
          "failed",
          record.evidencePath,
        );
      }
      await captureRecoveryStream(
        deps,
        record.evidencePath,
        stdoutPath,
        record.reviewer,
        parser,
        stdoutSnapshot,
      );
      const claudeResult = parser.finalResultEvent();
      if (record.reviewer === "claude" && claudeResult === undefined) {
        throw new ObservableLifecycleError(
          `${record.childName} observable reviewer leg has no valid final Claude result event; evidence: ${record.evidencePath}`,
          "failed",
          record.evidencePath,
        );
      }
      const stdout = record.reviewer === "claude" ? claudeResult! : "";
      const stderrSnapshot = await deps.snapshotSize(stderrPath);
      if (stderrSnapshot === undefined) {
        throw new ObservableLifecycleError(
          `${record.childName} observable reviewer leg is missing stderr evidence; evidence: ${record.evidencePath}`,
          "failed",
          record.evidencePath,
        );
      }
      const stderr = await readTextTail(
        deps,
        stderrPath,
        stderrSnapshot,
        REVIEWER_STDERR_TAIL_BYTES,
      );
      const output = record.reviewer === "codex"
        ? await deps.readFile(codexOutputPath(base))
        : undefined;
      if (record.reviewer === "codex" && (output === undefined || output.trim() === "")) {
        throw new ObservableLifecycleError(
          `${record.childName} observable reviewer leg has no authoritative Codex final message; evidence: ${record.evidencePath}`,
          "failed",
          record.evidencePath,
        );
      }
      validated = {
        version: 1,
        identity,
        process: { code, stdout, stderr, timedOut: false },
        ...(output === undefined ? {} : { output }),
      };
      await appendEvent(deps, record.evidencePath, {
        type: "review-leg-process-result",
        at: deps.now(),
        run: record.childName,
        reviewer: record.reviewer,
        resultId: record.resultId,
        code,
        stdoutBytes: stdoutSnapshot,
        stderrBytes: stderrSnapshot,
        reconciled: true,
        ...(output === undefined ? {} : { outputBytes: Buffer.byteLength(output) }),
      });
      await publishResult(deps, record.resultPath, validated, record.childName);
      await appendEvent(deps, record.evidencePath, {
        type: "review-leg-result-published",
        at: deps.now(),
        run: record.childName,
        reviewer: record.reviewer,
        resultId: record.resultId,
        resultPath: record.resultPath,
        reconciled: true,
      });
      validated = await readValidatedResult(
        deps,
        record.resultPath,
        identity,
        record.childName,
      );
    }

    await scanner.scan(deps, join(record.evidencePath, "events.jsonl"));
    scanner.assertComplete();
    assertUntainted(record.childName, record.evidencePath, scanner.controls);
    await settleOwnedChild({
      deps,
      scanner,
      childName: record.childName,
      evidencePath: record.evidencePath,
      resultId: record.resultId,
      ownedCleanupKey: record.ownedCleanupKey,
      wrapperExitedNormally: record.wrapperExitedNormally,
    });
    const at = deps.now();
    await publishLifecycle(deps, record.evidencePath, {
      ...lifecycle,
      state: "reconciled",
      updatedAt: at,
    });
    // Pane/status output is observational only. Rebuild it from the already
    // validated result identity so a missing or corrupt status write can never
    // discard an otherwise authoritative recovery verdict.
    const pane = initialObservablePaneState({
      reviewId: identity.reviewId,
      round: identity.round,
      reviewer: identity.reviewer,
      attempt: identity.attempt,
      childName: identity.childName,
      resultId: identity.id,
      at,
    });
    pane.status = "reconciled";
    pane.phase = "completed";
    pane.latestActivity = "atomic result reconciled";
    pane.updatedAt = at;
    pane.lastActivityAt = at;
    pane.result = {
      state: "final",
      code: validated.process.code,
      timedOut: false,
      resultId: record.resultId,
    };
    await publishObservation(
      deps,
      record.evidencePath,
      `${base}-observable-pane`,
      pane,
    );
    await cleanupTransient(
      deps,
      recoveryTransientPaths(record),
    );
    return {
      code: validated.process.code,
      stdout: validated.process.stdout,
      stderr: validated.process.stderr,
      timedOut: false,
      structuredOutput: validated.output,
    };
  } catch (error) {
    const state = error instanceof ObservableLifecycleError
      ? error.state
      : "interrupted";
    // An interrupted reconciliation is explicitly retryable. In particular, a
    // still-running child must retain its completion stream and bootstrap
    // identity; stopping or cleaning it here would make the instructed retry
    // impossible. Only terminal states discard evidence.
    if (state !== "interrupted") {
      await discardReconciliationEvidence({
        deps,
        record,
        lifecycle,
        state,
        diagnostic: errorDetail(error),
        controls: scanner.controls,
      });
    }
    if (error instanceof ObservableLifecycleError) {
      throw error;
    }
    throw new ObservableLifecycleError(
      `${record.childName} observable reviewer leg: ${errorDetail(error)}; evidence: ${record.evidencePath}`,
      state,
      record.evidencePath,
    );
  }
}

export async function discardObservableLeg(
  input: ReconcileObservableLegInput,
  overrides: Partial<ObservableAdapterDeps> = {},
): Promise<void> {
  const record = input.evidence;
  validateChildName(record.childName);
  const deps: ObservableAdapterDeps = {
    ...defaultObservableDeps(overrides.run ?? defaultUnavailableRun),
    ...overrides,
  };
  assertReconcilableIdentity(record, deps, {
    requireEventPrefix: false,
    // Terminal discard never accepts a verdict. Readable pre-authentication
    // journals can therefore fall back to exact name/evidence liveness proof.
    allowMissingOwnedCleanupKey: true,
  });
  let childAlreadyInactive = false;
  if (record.ownedCleanupKey === undefined) {
    childAlreadyInactive = !(await probeChild(
      deps,
      record.childName,
      record.evidencePath,
    ));
    if (!childAlreadyInactive) {
      throw legError(
        record.childName,
        "refusing to stop a live legacy child without authenticated cleanup ownership",
        record.evidencePath,
      );
    }
  }
  await cleanupRecordedObservableLeg(
    deps,
    record,
    false,
    childAlreadyInactive,
  );
}

export async function discardPreparedObservableLeg(
  childName: string,
  reviewer: ReviewerName,
  overrides: Partial<ObservableAdapterDeps> = {},
): Promise<void> {
  validateChildName(childName);
  const deps: ObservableAdapterDeps = {
    ...defaultObservableDeps(overrides.run ?? defaultUnavailableRun),
    ...overrides,
  };
  const base = tempPathBase(deps.tmpDir, childName);
  const cleanupPaths = preparedTransientPathsForBase(
    base,
    reviewer === "codex" && observableRetryAttempt(childName) === undefined,
  );
  let cleanupMetadataError: unknown;
  const rawCleanup = await deps.readFile(
    `${base}-observable-prepared-cleanup.json`,
  );
  if (rawCleanup !== undefined) {
    try {
      const parsed = preparedCleanupSchema.safeParse(JSON.parse(rawCleanup));
      if (!parsed.success || parsed.data.childName !== childName) {
        throw new WuxReviewError(
          `${childName} observable reviewer leg: invalid prepared cleanup identity`,
        );
      }
      validateObservableCleanup(
        parsed.data.cleanupFiles,
        parsed.data.cleanupDir,
        deps.tmpDir,
      );
      cleanupPaths.push(...parsed.data.cleanupFiles);
      if (parsed.data.cleanupDir !== undefined) {
        cleanupPaths.push(parsed.data.cleanupDir);
      }
    } catch (error) {
      cleanupMetadataError = error instanceof WuxReviewError
        ? error
        : new WuxReviewError(
            `${childName} observable reviewer leg: invalid prepared cleanup metadata`,
          );
    }
  }
  // prepareObservableRound durably owns this fresh execution-scoped name
  // before either backend starts. A parent crash after `wux run` but before
  // evidence discovery therefore still has enough identity to stop exactly
  // the launched child without attaching to any other run. Preserve cleanup
  // metadata when Wux cannot prove that exact child is inactive so recovery can
  // retry without orphaning attempt-specific paths. Invalid metadata must also
  // survive: it may be the only record of an isolated home outside this base.
  await stopOwnedChild({ deps, childName });
  if (cleanupMetadataError !== undefined) throw cleanupMetadataError;
  await cleanupTransient(deps, [...new Set(cleanupPaths)]);
}

function assertReconcilableIdentity(
  record: LegExecutionEvidence,
  deps: ObservableAdapterDeps,
  options: {
    requireEventPrefix: boolean;
    allowMissingOwnedCleanupKey?: boolean;
  },
): string {
  const base = record.transientBase;
  if (
    base === undefined
    || base !== tempPathBase(deps.tmpDir, record.childName)
    || !isAbsolute(record.evidencePath)
    || basename(record.evidencePath) !== record.childName
    || record.resultPath !== join(record.evidencePath, "result.json")
    || (
      record.ownedCleanupKey === undefined
        ? options.allowMissingOwnedCleanupKey !== true
        : !/^[0-9a-f]{64}$/.test(record.ownedCleanupKey)
    )
    || (options.requireEventPrefix && record.eventPrefix === undefined)
  ) {
    throw legError(record.childName, "unsafe or cross-leg reconciliation identity");
  }
  validateObservableCleanup(
    record.cleanupFiles,
    record.cleanupDir,
    deps.tmpDir,
  );
  return base;
}

async function readLifecycle(
  deps: ObservableAdapterDeps,
  evidencePath: string,
  identity: ObservableResultFile["identity"],
): Promise<ObservableLifecycleFile> {
  const raw = await deps.readFile(join(evidencePath, "lifecycle.json"));
  if (raw === undefined) {
    throw legError(identity.childName, "missing durable lifecycle.json", evidencePath);
  }
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    throw legError(identity.childName, "malformed durable lifecycle.json", evidencePath);
  }
  if (
    typeof value !== "object"
    || value === null
    || Array.isArray(value)
  ) {
    throw legError(identity.childName, "invalid durable lifecycle.json", evidencePath);
  }
  const lifecycle = value as Partial<ObservableLifecycleFile>;
  if (
    lifecycle.version !== 1
    || lifecycle.identity === undefined
    || JSON.stringify(lifecycle.identity) !== JSON.stringify(identity)
    || ![
      "pending",
      "running",
      "completed",
      "failed",
      "timed_out",
      "tainted",
      "interrupted",
      "reconciled",
    ].includes(String(lifecycle.state))
    || typeof lifecycle.startedAt !== "string"
    || typeof lifecycle.updatedAt !== "string"
  ) {
    throw legError(identity.childName, "invalid durable lifecycle.json identity", evidencePath);
  }
  return lifecycle as ObservableLifecycleFile;
}

async function captureRecoveryStream(
  deps: ObservableAdapterDeps,
  evidencePath: string,
  stdoutPath: string,
  reviewer: ReviewerName,
  parser: MachineEventParser,
  snapshotBytes: number,
): Promise<void> {
  let offset = 0;
  while (offset < snapshotBytes) {
    const bytes = await deps.readChunk(
      stdoutPath,
      offset,
      Math.min(MACHINE_EVENT_READ_CHUNK_BYTES, snapshotBytes - offset),
    );
    if (bytes.byteLength === 0) {
      throw new WuxReviewError(
        `${reviewer} observable machine stream shrank during reconciliation`,
      );
    }
    await deps.appendFile(
      join(evidencePath, "recovery-stream.jsonl"),
      `${JSON.stringify(machineStreamChunkRecord({
        at: deps.now(),
        reviewer,
        offset,
        bytes,
      }))}\n`,
    );
    parser.push(bytes);
    offset += bytes.byteLength;
  }
  parser.finish();
}

function codexOutputPath(
  transientBase: string,
): string {
  return `${transientBase}-observable-output`;
}

function throwIfAborted(
  input: ObservableLegInput,
  evidencePath: string,
): void {
  if (!input.signal?.aborted) return;
  const parent = input.signal.reason === "parent-interrupted";
  throw new ObservableLifecycleError(
    parent
      ? `${input.childName} observable reviewer leg interrupted by its parent`
      : `${input.childName} observable reviewer leg cancelled after its sibling failed`,
    parent ? "interrupted" : "failed",
    evidencePath,
  );
}

function assertUntainted(
  childName: string,
  evidencePath: string,
  controls: ObservableControlEvent[],
): void {
  if (controls.length === 0) return;
  const first = controls[0]!;
  const detail = first.action === "invalid-events"
    ? "malformed or rewritten Wux event evidence"
    : `external ${first.action} from ${first.actor} at ${first.at}`;
  throw new ObservableLifecycleError(
    `${childName} observable reviewer leg tainted by ${detail}; evidence: ${evidencePath}`,
    "tainted",
    evidencePath,
  );
}

async function finishTimedOutLeg(args: {
  deps: ObservableAdapterDeps;
  input: ObservableLegInput;
  evidencePath: string;
  panePath: string;
  paneState: ObservablePaneState;
  identity: ObservableResultFile["identity"];
  startedAt: string;
  resultId: string;
  ownedCleanupKey: string;
  scanner: WuxControlScanner;
  transientPaths: string[];
  diagnostic: string;
}): Promise<ObservableLegResult> {
  await publishTimeout(
    args.deps,
    args.evidencePath,
    args.panePath,
    args.paneState,
    args.input,
    args.resultId,
  );
  await publishLifecycle(args.deps, args.evidencePath, {
    version: 1,
    identity: args.identity,
    state: "timed_out",
    startedAt: args.startedAt,
    updatedAt: args.deps.now(),
    diagnostic: args.diagnostic,
  });
  await settleOwnedChild({
    deps: args.deps,
    scanner: args.scanner,
    childName: args.input.childName,
    evidencePath: args.evidencePath,
    resultId: args.resultId,
    env: args.input.env,
    ownedCleanupKey: args.ownedCleanupKey,
  });
  await cleanupTransient(args.deps, args.transientPaths);
  return { code: null, stdout: "", stderr: "", timedOut: true };
}

async function probeChild(
  deps: ObservableAdapterDeps,
  childName: string,
  evidencePath: string,
  env?: Record<string, string>,
): Promise<boolean> {
  let diagnostic = "Wux liveness probe failed";
  for (let attempt = 0; attempt < WUX_PROBE_ATTEMPTS; attempt++) {
    try {
      const read = await runWux(
        deps,
        ["wux", "--local", "read", childName, "--json"],
        env,
      );
      if (read.timedOut) {
        diagnostic = "Wux liveness probe timed out";
      } else if (read.code !== 0) {
        const detail = detailOf(read);
        if (isWuxRunAlreadyGone(detail)) {
          return false;
        }
        diagnostic = `Wux liveness probe failed: ${detail}`;
      } else {
        let data: unknown;
        try {
          data = JSON.parse(read.stdout);
        } catch {
          diagnostic = "invalid Wux liveness response";
          data = undefined;
        }
        const parsed = readSchema.safeParse(data);
        if (parsed.success) {
          if (
            parsed.data.name !== childName
            || parsed.data.runDir !== evidencePath
          ) {
            throw new ObservableLifecycleError(
              `${childName} observable reviewer leg: Wux liveness identity changed; evidence: ${evidencePath}`,
              "failed",
              evidencePath,
            );
          }
          return true;
        }
        diagnostic = "invalid Wux liveness response";
      }
    } catch (error) {
      if (error instanceof ObservableLifecycleError) throw error;
      diagnostic = `Wux liveness probe failed: ${errorDetail(error)}`;
    }
    if (attempt + 1 < WUX_PROBE_ATTEMPTS) {
      await deps.sleep(Math.min(50, Math.max(1, deps.pollIntervalMs)));
    }
  }
  throw new ObservableLifecycleError(
    `${childName} observable reviewer leg: ${diagnostic} after ${WUX_PROBE_ATTEMPTS} attempts; evidence: ${evidencePath}`,
    "failed",
    evidencePath,
  );
}

async function releaseWrapper(
  deps: ObservableAdapterDeps,
  releasePath: string,
  releasedPath: string,
  resultId: string,
): Promise<boolean> {
  // Arm cleanup before publication so parent death during the acknowledgement
  // wait cannot strand this exact result generation's release marker.
  deps.scheduleRm(releasePath, RELEASE_MARKER_REAP_MS);
  try {
    await deps.writeFile(releasePath, `${resultId}\n`);
  } catch {
    // Result publication is already atomic and authoritative. Terminal cleanup
    // removes argsPath (releasing the wrapper) and reaps the exact Wux child, so
    // a transient release-marker failure cannot invalidate that result.
    return false;
  }
  for (let poll = 0; poll < RELEASE_ACK_POLLS; poll++) {
    if ((await deps.readFile(releasedPath).catch(() => undefined)) === resultId) {
      return true;
    }
    await deps.sleep(Math.min(50, Math.max(1, deps.pollIntervalMs)));
  }
  return false;
}

async function waitForChildExit(
  deps: ObservableAdapterDeps,
  childName: string,
  evidencePath: string,
  env?: Record<string, string>,
): Promise<boolean> {
  return waitForChildInactivity(
    deps,
    async () => !(await probeChild(deps, childName, evidencePath, env)),
  );
}

async function waitForChildInactivity(
  deps: ObservableAdapterDeps,
  inactive: () => Promise<boolean>,
): Promise<boolean> {
  const baseDelay = Math.min(50, Math.max(1, deps.pollIntervalMs));
  for (
    let probe = 0;
    probe <= CHILD_REAP_BACKOFF_MULTIPLIERS.length;
    probe++
  ) {
    if (await inactive()) return true;
    const multiplier = CHILD_REAP_BACKOFF_MULTIPLIERS[probe];
    if (multiplier !== undefined) {
      await deps.sleep(baseDelay * multiplier);
    }
  }
  return false;
}

interface StopObservableChildResult {
  inactive: boolean;
  error?: unknown;
}

async function stopObservableChild(args: {
  deps: ObservableAdapterDeps;
  childName: string;
  evidencePath?: string;
  resultId?: string;
  env?: Record<string, string>;
  ownedCleanupKey?: string;
  scanner?: WuxControlScanner;
  wrapperExitedNormally?: boolean;
}): Promise<StopObservableChildResult> {
  try {
    await stopOwnedChild({
      deps: args.deps,
      childName: args.childName,
      evidencePath: args.evidencePath,
      resultId: args.resultId,
      env: args.env,
      ownedCleanupKey: args.ownedCleanupKey,
      allowMissingOwnedStopEvidence: args.wrapperExitedNormally === true
        || args.scanner?.hasAuthenticatedOwnedCleanup() === true,
    });
    return { inactive: true };
  } catch (error) {
    return { inactive: false, error };
  }
}

interface StopOwnedChildInput {
  deps: ObservableAdapterDeps;
  childName: string;
  evidencePath?: string;
  resultId?: string;
  env?: Record<string, string>;
  ownedCleanupKey?: string;
  allowMissingOwnedStopEvidence?: boolean;
}

async function stopOwnedChild(input: StopOwnedChildInput): Promise<void> {
  const {
    deps,
    childName,
    evidencePath,
    resultId,
    env,
    ownedCleanupKey,
    allowMissingOwnedStopEvidence = false,
  } = input;
  const eventsPath = evidencePath === undefined
    ? undefined
    : join(evidencePath, "events.jsonl");
  const beforeStopBytes = eventsPath === undefined
    ? undefined
    : await deps.snapshotSize(eventsPath);
  const cleanupActor = eventsPath === undefined
    || resultId === undefined
    || ownedCleanupKey === undefined
    ? undefined
    : `wux-review-${randomBytes(16).toString("hex")}`;
  const stopped = await runWux(
    deps,
    ["wux", "--local", "stop", childName, "--yes"],
    // Released Wux >= 2026.06.21.1 derives CLI mutation actors from USER,
    // falling back to LOGNAME. Set both so the authenticated stop identity is
    // stable even when the caller supplied only one of them.
    cleanupActor === undefined
      ? env
      : { ...env, USER: cleanupActor, LOGNAME: cleanupActor },
  );
  let ownedStop: { at: string; by: string } | undefined;
  if (
    evidencePath !== undefined
    && eventsPath !== undefined
    && beforeStopBytes !== undefined
    && cleanupActor !== undefined
    && resultId !== undefined
    && ownedCleanupKey !== undefined
  ) {
    // The Wux process may be killed after the stop reached the tmux/state
    // boundary but before its response reached us. Authenticate the exact
    // nonce-stamped event first, regardless of the CLI exit/timeout result.
    const stopScanner = new WuxControlScanner(
      childName,
      resultId,
      deps.now,
      ownedCleanupKey,
    );
    ownedStop = await stopScanner.findOwnedStopSince(
      deps,
      eventsPath,
      beforeStopBytes,
      cleanupActor,
    );
    if (ownedStop !== undefined) {
      await appendEvent(deps, evidencePath, {
        type: "review-leg-owned-cleanup",
        at: deps.now(),
        run: childName,
        resultId,
        stopAt: ownedStop.at,
        stopBy: ownedStop.by,
        proof: ownedCleanupProof(
          ownedCleanupKey,
          childName,
          resultId,
          ownedStop.at,
          ownedStop.by,
        ),
      });
    }
  }
  if ((stopped.timedOut || stopped.code !== 0) && ownedStop === undefined) {
    const detail = detailOf(stopped);
    const alreadyGone = !stopped.timedOut && isWuxRunAlreadyGone(detail);
    let failure: string | undefined;
    if (alreadyGone) {
      if (cleanupActor !== undefined && !allowMissingOwnedStopEvidence) {
        failure = `exact-child cleanup found an already-gone child without authenticated stop evidence: ${detail}`;
      }
    } else if (!stopped.timedOut || !allowMissingOwnedStopEvidence) {
      failure = `exact-child cleanup failed: ${detail}`;
    }
    if (failure !== undefined) {
      throw legError(childName, failure);
    }
  }
  if (
    stopped.code === 0
    && cleanupActor !== undefined
    && ownedStop === undefined
    && !allowMissingOwnedStopEvidence
  ) {
    throw legError(
      childName,
      "exact-child cleanup succeeded without an authenticated Wux stop event",
    );
  }
  if (evidencePath === undefined) {
    if (await waitForChildInactivity(
      deps,
      async () => (await isWuxRunActive(deps, childName, env)) === false,
    )) return;
    throw legError(childName, "exact-child cleanup did not reap the Wux session");
  }
  if (await waitForChildInactivity(
    deps,
    async () => !(await probeChild(deps, childName, evidencePath, env)),
  )) return;
  throw legError(childName, "exact-child cleanup did not reap the Wux session");
}

async function settleOwnedChild(args: {
  deps: ObservableAdapterDeps;
  scanner: WuxControlScanner;
  childName: string;
  evidencePath: string;
  resultId: string;
  env?: Record<string, string>;
  ownedCleanupKey?: string;
  wrapperExitedNormally?: boolean;
}): Promise<void> {
  const stopped = await stopObservableChild(args);
  let cleanupError = stopped.error;
  try {
    await verifyControlEvidence(
      args.deps,
      args.scanner,
      args.childName,
      args.evidencePath,
    );
  } catch (error) {
    // An external control event is the stronger terminal diagnosis even when
    // it also prevented the exact owned-cleanup marker from being published.
    if (
      error instanceof ObservableLifecycleError
      && error.state === "tainted"
    ) {
      throw error;
    }
    cleanupError ??= error;
  }
  if (cleanupError !== undefined) throw cleanupError;
}

async function verifyControlEvidence(
  deps: ObservableAdapterDeps,
  scanner: WuxControlScanner,
  childName: string,
  evidencePath: string,
): Promise<void> {
  await scanner.scan(deps, join(evidencePath, "events.jsonl"));
  scanner.assertComplete();
  assertUntainted(childName, evidencePath, scanner.controls);
}

async function discardReconciliationEvidence(args: {
  deps: ObservableAdapterDeps;
  record: LegExecutionEvidence;
  lifecycle: ObservableLifecycleFile;
  state: ObservableLifecycleState;
  diagnostic: string;
  controls?: ObservableControlEvent[];
}): Promise<void> {
  await publishLifecycle(args.deps, args.record.evidencePath, {
    ...args.lifecycle,
    state: args.state,
    updatedAt: args.deps.now(),
    diagnostic: args.diagnostic,
    ...(args.controls === undefined || args.controls.length === 0
      ? {}
      : { controls: args.controls }),
  }).catch(() => undefined);
  await cleanupRecordedObservableLeg(args.deps, args.record, true);
}

async function cleanupRecordedObservableLeg(
  deps: ObservableAdapterDeps,
  record: LegExecutionEvidence,
  preserveOnStopFailure: boolean,
  childAlreadyInactive = false,
): Promise<void> {
  if (!childAlreadyInactive) {
    try {
      await stopOwnedChild({
        deps,
        childName: record.childName,
        evidencePath: record.evidencePath,
        resultId: record.resultId,
        ownedCleanupKey: record.ownedCleanupKey,
        // This is a terminal discard, never verdict acceptance. A missing stop
        // marker is safe only after stopOwnedChild independently proves the exact
        // journaled child inactive; an unrecognized stop failure or live child
        // still rejects and preserves every bootstrap path for another retry.
        allowMissingOwnedStopEvidence: true,
      });
    } catch (error) {
      if (preserveOnStopFailure) {
        // A later terminal-cleanup retry still needs every bootstrap path to
        // identify and reclaim an exact child whose stop was not proven.
        return;
      }
      throw error;
    }
  }
  await deps.rm(`${record.resultPath}.tmp`).catch(() => undefined);
  await cleanupTransient(deps, recoveryTransientPaths(record));
}

function isWuxRunAlreadyGone(detail: string): boolean {
  const message = detail.replace(/^wux:\s*/i, "");
  return WUX_ALREADY_GONE_PATTERNS.some((pattern) => pattern.test(message));
}

async function cleanupTransient(
  deps: ObservableAdapterDeps,
  paths: string[],
): Promise<void> {
  try {
    await Promise.all(paths.map((path) => deps.rm(path)));
  } catch (error) {
    throw new WuxReviewError(`observable transient cleanup failed: ${errorDetail(error)}`);
  }
}

async function publishLifecycle(
  deps: ObservableAdapterDeps,
  evidencePath: string,
  lifecycle: ObservableLifecycleFile,
): Promise<void> {
  const path = join(evidencePath, "lifecycle.json");
  const tmp = `${path}.tmp`;
  await deps.writeFile(tmp, `${JSON.stringify(lifecycle)}\n`);
  await deps.rename(tmp, path);
  await appendEvent(deps, evidencePath, {
    type: "review-leg-lifecycle",
    at: lifecycle.updatedAt,
    run: lifecycle.identity.childName,
    reviewer: lifecycle.identity.reviewer,
    resultId: lifecycle.identity.id,
    state: lifecycle.state,
  });
}

async function publishResult(
  deps: ObservableAdapterDeps,
  resultPath: string,
  result: ObservableResultFile,
  childName: string,
): Promise<void> {
  const tmp = `${resultPath}.tmp`;
  if ((await deps.readFile(resultPath)) !== undefined) {
    throw legError(
      childName,
      "duplicate or replayed atomic result publication",
      dirname(resultPath),
    );
  }
  if ((await deps.readFile(tmp)) !== undefined) {
    await preserveRejectedResult(deps, resultPath);
    throw legError(childName, "partial atomic result publication", dirname(resultPath));
  }
  try {
    await deps.writePrivateFile(tmp, `${JSON.stringify(result)}\n`);
    if ((await deps.readFile(resultPath)) !== undefined) {
      throw legError(
        childName,
        "duplicate or replayed atomic result publication",
        dirname(resultPath),
      );
    }
    await deps.rename(tmp, resultPath);
  } catch (error) {
    await preserveRejectedResult(deps, resultPath).catch(() => undefined);
    throw error;
  }
}

async function preserveRejectedResult(
  deps: ObservableAdapterDeps,
  resultPath: string,
): Promise<void> {
  const tmp = `${resultPath}.tmp`;
  if ((await deps.readFile(tmp)) === undefined) return;
  const rejected = join(dirname(resultPath), "result.rejected.json");
  if ((await deps.readFile(rejected)) !== undefined) {
    await deps.rm(tmp);
    return;
  }
  await deps.rename(tmp, rejected);
}

async function publishTimeout(
  deps: ObservableAdapterDeps,
  evidencePath: string,
  panePath: string,
  paneState: ObservablePaneState,
  input: ObservableLegInput,
  resultId: string,
): Promise<void> {
  const at = deps.now();
  paneState.status = "timed-out";
  paneState.phase = "failed";
  paneState.latestActivity = "reviewer timed out";
  paneState.updatedAt = at;
  paneState.lastActivityAt = at;
  paneState.result = {
    state: "pending",
    code: null,
    timedOut: true,
    resultId,
  };
  await publishObservation(deps, evidencePath, panePath, paneState);
  await appendEvent(deps, evidencePath, {
    type: "review-leg-timeout",
    at,
    run: input.childName,
    reviewer: input.reviewer,
    resultId,
  });
}

async function finishMachineSnapshot(
  deps: ObservableAdapterDeps,
  evidencePath: string,
  stdoutPath: string,
  reviewer: ReviewerName,
  initialOffset: number,
  parser: MachineEventParser,
  paneState: ObservablePaneState,
  snapshotBytes: number,
): Promise<void> {
  if (initialOffset > snapshotBytes) {
    throw new WuxReviewError(
      `${reviewer} observable machine stream shrank during capture`,
    );
  }
  let offset = initialOffset;
  while (offset < snapshotBytes) {
    const bytes = await deps.readChunk(
      stdoutPath,
      offset,
      Math.min(MACHINE_EVENT_READ_CHUNK_BYTES, snapshotBytes - offset),
    );
    if (bytes.byteLength === 0) {
      throw new WuxReviewError(
        `${reviewer} observable machine stream shrank during capture`,
      );
    }
    offset = await captureMachineChunk(
      deps,
      evidencePath,
      reviewer,
      offset,
      bytes,
      parser,
      paneState,
    );
  }
  applyParsedMachineEvents(paneState, parser.finish(), deps.now());
}

async function readTextTail(
  deps: ObservableAdapterDeps,
  path: string,
  snapshotBytes: number,
  limitBytes: number,
): Promise<string> {
  const start = Math.max(0, snapshotBytes - Math.max(0, limitBytes));
  const bytes = new Uint8Array(snapshotBytes - start);
  let offset = start;
  while (offset < snapshotBytes) {
    const chunk = await deps.readChunk(
      path,
      offset,
      Math.min(MACHINE_EVENT_READ_CHUNK_BYTES, snapshotBytes - offset),
    );
    if (chunk.byteLength === 0) {
      break;
    }
    const retained = chunk.subarray(0, snapshotBytes - offset);
    bytes.set(retained, offset - start);
    offset += retained.byteLength;
  }
  return new TextDecoder().decode(bytes.subarray(0, offset - start));
}

async function drainMachineStream(
  deps: ObservableAdapterDeps,
  evidencePath: string,
  stdoutPath: string,
  reviewer: ReviewerName,
  initialOffset: number,
  parser: MachineEventParser,
  paneState: ObservablePaneState,
): Promise<{ offset: number }> {
  let offset = initialOffset;
  // Bound one live observation pass so a noisy child cannot starve
  // completion/timeout polling. Post-marker capture uses a fixed file snapshot.
  for (let read = 0; read < OBSERVABLE_DRAIN_READS_PER_PASS; read++) {
    const bytes = await deps.readChunk(
      stdoutPath,
      offset,
      MACHINE_EVENT_READ_CHUNK_BYTES,
    );
    if (bytes.byteLength === 0) {
      return { offset };
    }
    offset = await captureMachineChunk(
      deps,
      evidencePath,
      reviewer,
      offset,
      bytes,
      parser,
      paneState,
    );
  }
  return { offset };
}

async function captureMachineChunk(
  deps: ObservableAdapterDeps,
  evidencePath: string,
  reviewer: ReviewerName,
  offset: number,
  bytes: Uint8Array,
  parser: MachineEventParser,
  paneState: ObservablePaneState,
): Promise<number> {
  const at = deps.now();
  await deps.appendFile(
    join(evidencePath, MACHINE_STREAM_EVIDENCE_FILE),
    `${JSON.stringify(machineStreamChunkRecord({ at, reviewer, offset, bytes }))}\n`,
  );
  paneState.lastActivityAt = at;
  applyParsedMachineEvents(paneState, parser.push(bytes), at);
  return offset + bytes.byteLength;
}

function applyParsedMachineEvents(
  state: ObservablePaneState,
  events: ParsedMachineEvent[],
  at: string,
): void {
  for (const event of events) {
    if (event.observation.phase !== undefined) {
      state.phase = event.observation.phase;
    }
    if (event.observation.latestActivity !== undefined) {
      state.latestActivity = event.observation.latestActivity;
    }
    if (event.diagnostic !== undefined) {
      state.diagnostics[event.diagnostic.kind] += 1;
    }
    state.lastActivityAt = at;
  }
}

// Pane/status rendering is observational: a formatter or pane/status write
// failure is recorded safely and never changes the atomic result path. Raw event
// capture and result publication use separate writes and remain load-bearing.
async function publishObservation(
  deps: ObservableAdapterDeps,
  evidencePath: string,
  panePath: string,
  state: ObservablePaneState,
): Promise<void> {
  let failed = false;
  let pane: string | undefined;
  try {
    pane = deps.renderPane(state, state.updatedAt);
  } catch {
    failed = true;
    state.diagnostics.renderer += 1;
  }

  try {
    await publishStatus(deps, evidencePath, state);
  } catch {
    failed = true;
    state.diagnostics.renderer += 1;
    // A surviving pane must include the status-write failure count.
    try {
      pane = deps.renderPane(state, state.updatedAt);
    } catch {
      state.diagnostics.renderer += 1;
      pane = undefined;
    }
  }

  if (pane !== undefined) {
    try {
      await deps.appendFile(panePath, pane);
    } catch {
      failed = true;
      state.diagnostics.renderer += 1;
      // Status may be the surviving observation sink; republish it with the
      // pane-write failure included rather than leaving its count stale.
      await publishStatus(deps, evidencePath, state).catch(() => undefined);
    }
  }

  if (failed) {
    await appendEvent(deps, evidencePath, {
      type: "review-leg-observer-diagnostic",
      at: deps.now(),
      reviewer: state.reviewer,
      category: "renderer-failure",
    }).catch(() => undefined);
  }
}

async function assertNoCollision(
  deps: ObservableAdapterDeps,
  childName: string,
  env?: Record<string, string>,
): Promise<void> {
  const status = await runWux(deps, ["wux", "--local", "status", "--json"], env);
  if (status.timedOut || status.code !== 0) {
    throw legError(childName, `wux status --json failed: ${detailOf(status)}`);
  }
  let data: unknown;
  try {
    data = JSON.parse(status.stdout);
  } catch {
    throw legError(childName, "invalid wux status --json response");
  }
  const parsed = statusListSchema.safeParse(data);
  if (!parsed.success) {
    throw legError(childName, "invalid wux status --json response");
  }
  if (parsed.data.some((run) => run.name === childName)) {
    throw legError(childName, "name collision; refusing to attach to an existing Wux run");
  }
}

async function isWuxRunActive(
  deps: ObservableAdapterDeps,
  childName: string,
  env?: Record<string, string>,
): Promise<boolean | undefined> {
  const status = await runWux(
    deps,
    ["wux", "--local", "status", "--json"],
    env,
  );
  if (status.timedOut || status.code !== 0) {
    return undefined;
  }
  try {
    const parsed = statusListSchema.safeParse(JSON.parse(status.stdout));
    return parsed.success
      ? parsed.data.some((run) =>
          run.name === childName && run.status === "running"
        )
      : undefined;
  } catch {
    return undefined;
  }
}

async function discoverRunDir(
  deps: ObservableAdapterDeps,
  childName: string,
  env?: Record<string, string>,
): Promise<string> {
  const read = await runWux(deps, ["wux", "--local", "read", childName, "--json"], env);
  if (read.timedOut || read.code !== 0) {
    throw legError(childName, `wux read --json failed: ${detailOf(read)}`);
  }
  let data: unknown;
  try {
    data = JSON.parse(read.stdout);
  } catch {
    throw legError(childName, "invalid wux read --json response");
  }
  const parsed = readSchema.safeParse(data);
  if (!parsed.success || parsed.data.name !== childName) {
    throw legError(childName, "invalid wux read --json response");
  }
  const path = parsed.data.runDir;
  if (!isAbsolute(path) || basename(path) !== childName) {
    throw legError(childName, `unsafe runDir from wux read --json: ${JSON.stringify(path)}`);
  }
  return path;
}

async function publishStatus(
  deps: ObservableAdapterDeps,
  evidencePath: string,
  status: unknown,
): Promise<void> {
  const path = join(evidencePath, "status.json");
  const tmp = `${path}.tmp`;
  await deps.writeFile(tmp, `${JSON.stringify(status)}\n`);
  await deps.rename(tmp, path);
}

async function readValidatedResult(
  deps: ObservableAdapterDeps,
  resultPath: string,
  expected: ObservableResultFile["identity"],
  childName: string,
): Promise<ObservableResultFile> {
  const raw = await deps.readFile(resultPath);
  if (raw === undefined || raw.trim() === "") {
    throw legError(childName, "missing atomic result.json", dirname(resultPath));
  }
  let data: unknown;
  try {
    data = JSON.parse(raw);
  } catch {
    throw legError(childName, "invalid atomic result.json", dirname(resultPath));
  }
  const parsed = resultSchema.safeParse(data);
  if (!parsed.success || JSON.stringify(parsed.data.identity) !== JSON.stringify(expected)) {
    throw legError(childName, "invalid atomic result.json identity", dirname(resultPath));
  }
  return parsed.data;
}

async function appendEvent(
  deps: ObservableAdapterDeps,
  evidencePath: string,
  event: unknown,
): Promise<void> {
  await deps.appendFile(join(evidencePath, "events.jsonl"), `${JSON.stringify(event)}\n`);
}

async function readFileChunk(
  path: string,
  offset: number,
  maxBytes: number,
): Promise<Uint8Array> {
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    handle = await open(path, "r");
    const buffer = Buffer.alloc(Math.max(0, maxBytes));
    const { bytesRead } = await handle.read(buffer, 0, buffer.byteLength, offset);
    return buffer.subarray(0, bytesRead);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      return new Uint8Array();
    }
    throw err;
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

async function readFileSnapshotSize(path: string): Promise<number | undefined> {
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    handle = await open(path, "r");
    return (await handle.stat()).size;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      return undefined;
    }
    throw err;
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

export function scheduleFileRemoval(path: string, delayMs: number): void {
  try {
    const child = Bun.spawn(
      [
        "/bin/bash",
        "-c",
        'PATH=/usr/bin:/bin; sleep "$1"; rm -f -- "$2"',
        "wux-review-reaper",
        (Math.max(0, delayMs) / 1000).toFixed(3),
        path,
      ],
      {
        stdin: "ignore",
        stdout: "ignore",
        stderr: "ignore",
      },
    );
    child.unref();
  } catch {
    const timer = setTimeout(() => {
      void rm(path, { force: true });
    }, Math.max(0, delayMs));
    timer.unref();
  }
}

async function runWux(
  deps: ObservableAdapterDeps,
  cmd: string[],
  env?: Record<string, string>,
): Promise<ObservableRunResult> {
  try {
    return await deps.run(cmd, { timeoutMs: WUX_COMMAND_TIMEOUT_MS, env });
  } catch (err) {
    return { code: 1, stdout: "", stderr: errorDetail(err), timedOut: false };
  }
}

function validateChildName(name: string): void {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,191}$/.test(name)) {
    throw new WuxReviewError(`invalid observable reviewer leg name: ${JSON.stringify(name)}`);
  }
}

function tempPathBase(tmpDir: string, childName: string): string {
  validateChildName(childName);
  return `${tmpDir}/${childName}`;
}

function transientPathsForBase(
  base: string,
  release: { releasePath: string; releasedPath: string },
): string[] {
  return [
    ...baseTransientPathsForBase(base),
    release.releasePath,
    release.releasedPath,
    `${release.releasedPath}.tmp`,
  ];
}

function releasePathsForBase(
  base: string,
  resultId: string,
): { releasePath: string; releasedPath: string } {
  const generation = createHash("sha256").update(resultId).digest("hex");
  return {
    releasePath: `${base}-observable-release-${generation}`,
    releasedPath: `${base}-observable-released-${generation}`,
  };
}

function baseTransientPathsForBase(base: string): string[] {
  return [
    `${base}-observable-args`,
    `${base}-observable-env`,
    `${base}-observable-stdin`,
    `${base}-observable-stdout`,
    `${base}-observable-stderr`,
    `${base}-observable-done`,
    `${base}-observable-done.tmp`,
    `${base}-observable-timeout`,
    `${base}-observable-timeout.tmp`,
    `${base}-observable-ready`,
    `${base}-observable-pane`,
    `${base}-observable-prepared-cleanup.json`,
    codexOutputPath(base),
    `${codexOutputPath(base)}.tmp`,
    `${base}-observable.sh`,
  ];
}

function preparedTransientPathsForBase(
  base: string,
  includeHeadlessCodexPaths: boolean,
): string[] {
  return [
    ...baseTransientPathsForBase(base),
    // The base Codex attempt creates these before entering the observable
    // adapter. Retry children are journaled only after prepared-cleanup.json
    // records the real shared paths, which do not carry the -aN suffix.
    ...(includeHeadlessCodexPaths
      ? [`${base}-prompt.md`, `${base}-last.txt`]
      : []),
  ];
}

function recoveryTransientPaths(
  record: LegExecutionEvidence,
): string[] {
  const base = record.transientBase!;
  return transientPathsForBase(
    base,
    releasePathsForBase(base, record.resultId),
  );
}

function validateObservableCleanup(
  files: string[] | undefined,
  dir: string | undefined,
  adapterTmpDir: string,
): void {
  const cleanupRoot = resolve(adapterTmpDir);
  for (const path of files ?? []) {
    if (
      !isAbsolute(path)
      || path === "/"
      || !resolve(path).startsWith(`${cleanupRoot}${sep}`)
    ) {
      throw new WuxReviewError(`unsafe observable cleanup file: ${JSON.stringify(path)}`);
    }
  }
  if (
    dir !== undefined
    && (
      !isAbsolute(dir)
      || dir === "/"
      || !resolve(dir).startsWith(`${resolve(tmpdir())}${sep}`)
      || (
        !basename(dir).startsWith("wuxr-codex-home-")
        && !basename(dir).startsWith("wuxr-reviewer-cwd-")
      )
    )
  ) {
    throw new WuxReviewError(`unsafe observable cleanup directory: ${JSON.stringify(dir)}`);
  }
}

function shq(path: string): string {
  return `'${path.replace(/'/g, `'\\''`)}'`;
}

function detailOf(result: ObservableRunResult): string {
  return wuxOutputDetail(result.stderr)
    || wuxOutputDetail(result.stdout)
    || (result.timedOut ? "timed out" : `exit ${result.code}`);
}

function wuxOutputDetail(text: string): string {
  const line = oneLine(text);
  if (line === "") return "";
  try {
    const parsed: unknown = JSON.parse(line);
    if (
      typeof parsed === "object"
      && parsed !== null
      && "error" in parsed
      && typeof parsed.error === "object"
      && parsed.error !== null
      && "message" in parsed.error
      && typeof parsed.error.message === "string"
    ) {
      return oneLine(parsed.error.message);
    }
  } catch {
    // Plain released-Wux diagnostics remain valid input below.
  }
  return line;
}

function legError(
  childName: string,
  detail: string,
  evidencePath?: string,
): WuxReviewError {
  return new WuxReviewError(
    `${childName} observable reviewer leg: ${detail}${evidencePath === undefined ? "" : `; evidence: ${evidencePath}`}`,
  );
}

function serializeEnvironment(overrides?: Record<string, string>): string {
  const effective = { ...process.env, ...overrides };
  const entries = Object.entries(effective)
    .filter((entry): entry is [string, string] => typeof entry[1] === "string")
    .map(([name, value]) => `${name}=${value}`);
  return encodeNulRecords(entries);
}

function encodeNulRecords(records: string[]): string {
  return records.length === 0 ? "" : `${records.join("\0")}\0`;
}

function concat(left: Uint8Array, right: Uint8Array): Uint8Array {
  if (left.byteLength === 0) return Uint8Array.from(right);
  if (right.byteLength === 0) return left;
  const combined = new Uint8Array(left.byteLength + right.byteLength);
  combined.set(left);
  combined.set(right, left.byteLength);
  return combined;
}

const defaultUnavailableRun: ObservableRun = async () => ({
  code: 1,
  stdout: "",
  stderr: "observable run dependency is unavailable",
  timedOut: false,
});
