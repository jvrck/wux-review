import type { ReviewerName } from "../review/types";
import {
  observeMachineEvent,
  type SafeEventObservation,
} from "../review/observable-render";

export const MACHINE_EVENT_PARSE_LIMIT_BYTES = 256 * 1024;
export const MACHINE_EVENT_READ_CHUNK_BYTES = 64 * 1024;
export const MACHINE_RESULT_EVENT_LIMIT_BYTES = 16 * 1024 * 1024;
// An oversized Codex command event can contain the whole reviewed diff in
// `aggregated_output`. Keep only enough framing to recognize the stable event
// envelope and final process fields; never retain that output itself.
export const OVERSIZED_CODEX_SIGNAL_BYTES = 4 * 1024;

export function isClaudeResultEvent(
  value: unknown,
): value is Record<string, unknown> & { type: "result" } {
  return typeof value === "object"
    && value !== null
    && (value as { type?: unknown }).type === "result";
}

export interface MachineStreamChunkRecord {
  type: "reviewer-machine-stream-chunk";
  at: string;
  reviewer: ReviewerName;
  offset: number;
  byteLength: number;
  encoding: "base64";
  data: string;
}

export interface MachineEventDiagnostic {
  kind: "malformed" | "oversized" | "unknown";
}

export interface ParsedMachineEvent {
  observation: SafeEventObservation;
  diagnostic?: MachineEventDiagnostic;
}

// This is deliberately only a set of verdict-relevant facts, never a copy of
// JSONL. Codex stdout can contain the reviewed diff and model reasoning, so it
// must remain durable evidence rather than diagnostic text.
export interface CodexExecutionSignal {
  commandExecutions: number;
  sawError: boolean;
  sawTurnFailed: boolean;
  sandboxUnavailable: boolean;
  unclassifiedOversized: boolean;
}

export function emptyCodexExecutionSignal(): CodexExecutionSignal {
  return {
    commandExecutions: 0,
    sawError: false,
    sawTurnFailed: false,
    sandboxUnavailable: false,
    unclassifiedOversized: false,
  };
}

export function codexExecutionFailure(
  signal: CodexExecutionSignal | undefined,
  stderr: string,
):
  | "sandbox unavailable"
  | "turn failed"
  | "reported error"
  | "unclassified oversized event"
  | "ran zero commands"
  | "missing execution signal"
  | undefined {
  if (sandboxUnavailable(stderr) || signal?.sandboxUnavailable === true) return "sandbox unavailable";
  if (signal === undefined) return "missing execution signal";
  if (signal.sawTurnFailed) return "turn failed";
  // Codex can use top-level error events for a retriable stream reconnect. The
  // literal #15 contract still makes every error fatal for this attempt, so it
  // consumes the normal bounded retry rather than silently approving.
  if (signal.sawError) return "reported error";
  if (signal.unclassifiedOversized) return "unclassified oversized event";
  if (signal.commandExecutions === 0) return "ran zero commands";
  return undefined;
}

// The raw stream evidence is byte-exact and immediately appendable even when a
// CLI splits one JSON event across writes. Concatenating decoded `data` in
// ascending `offset` order reconstructs stdout exactly, including malformed,
// unknown, partial, and unterminated records.
export function machineStreamChunkRecord(input: {
  at: string;
  reviewer: ReviewerName;
  offset: number;
  bytes: Uint8Array;
}): MachineStreamChunkRecord {
  return {
    type: "reviewer-machine-stream-chunk",
    at: input.at,
    reviewer: input.reviewer,
    offset: input.offset,
    byteLength: input.bytes.byteLength,
    encoding: "base64",
    data: Buffer.from(input.bytes).toString("base64"),
  };
}

// Bounded JSONL parser for live metadata only. Raw bytes are recorded separately
// before they reach this class, so dropping an oversized line from parsing never
// drops evidence. The parser retains at most parseLimit bytes for one partial
// line and never includes raw content in diagnostics.
export class MachineEventParser {
  private pending: Uint8Array<ArrayBufferLike> = new Uint8Array();
  private discardingOversized = false;
  private oversizedCodexHead: Uint8Array<ArrayBufferLike> = new Uint8Array();
  private oversizedCodexTail: Uint8Array<ArrayBufferLike> = new Uint8Array();
  private lastClaudeResultEvent: string | undefined;
  private claudeResultSegments: Uint8Array[] = [];
  private claudeResultBytes = 0;
  private discardingOversizedClaudeResult = false;
  private readonly codexSignal = emptyCodexExecutionSignal();
  private readonly stderrSandboxDetector = new SandboxUnavailableDetector();

  constructor(
    private readonly reviewer: ReviewerName,
    private readonly parseLimit = MACHINE_EVENT_PARSE_LIMIT_BYTES,
    private readonly resultLimit = MACHINE_RESULT_EVENT_LIMIT_BYTES,
  ) {}

  push(bytes: Uint8Array): ParsedMachineEvent[] {
    const events: ParsedMachineEvent[] = [];
    let start = 0;
    for (let index = 0; index < bytes.byteLength; index++) {
      if (bytes[index] !== 0x0a) {
        continue;
      }
      this.consumeSegment(bytes.subarray(start, index), true, events);
      start = index + 1;
    }
    if (start < bytes.byteLength) {
      this.consumeSegment(bytes.subarray(start), false, events);
    }
    return events;
  }

  finish(): ParsedMachineEvent[] {
    const events: ParsedMachineEvent[] = [];
    const resultLineRejected = this.finishClaudeResultLine();
    if (this.discardingOversized) {
      this.observeOversizedCodexLine();
      events.push({
        observation: {},
        diagnostic: { kind: "oversized" },
      });
    } else if (this.pending.byteLength > 0) {
      if (this.pendingJsonBytes() > this.parseLimit) {
        this.rememberOversizedCodexSegment(this.pending);
        this.observeOversizedCodexLine();
        events.push({
          observation: {},
          diagnostic: { kind: "oversized" },
        });
      } else {
        const parsed = this.parseLine(
          this.pending,
          !resultLineRejected,
        );
        if (parsed !== undefined) {
          events.push(parsed);
        }
      }
    }
    this.pending = new Uint8Array();
    this.resetOversizedLine();
    return events;
  }

  // Observable verdict publication needs only Claude's final result envelope,
  // never the whole machine stream. Keeping the last bounded result line here
  // lets raw evidence scale with chunked disk writes while result.json stays
  // proportional to the actual verdict payload.
  finalResultEvent(): string | undefined {
    return this.lastClaudeResultEvent;
  }

  codexExecutionSignal(): CodexExecutionSignal | undefined {
    return this.reviewer === "codex" ? { ...this.codexSignal } : undefined;
  }

  // Stderr is not reviewer-controlled JSONL, but it can still be larger than
  // the retained diagnostic tail. Keep sandbox classification sticky while the
  // caller drains it, including a diagnostic split across adjacent chunks.
  observeStderr(bytes: Uint8Array): void {
    if (this.reviewer !== "codex") return;
    if (this.stderrSandboxDetector.observe(bytes)) {
      this.codexSignal.sandboxUnavailable = true;
    }
  }

  private consumeSegment(
    segment: Uint8Array,
    terminated: boolean,
    events: ParsedMachineEvent[],
  ): void {
    const resultLineRejected = this.consumeClaudeResultSegment(
      segment,
      terminated,
    );
    if (this.discardingOversized) {
      this.rememberOversizedCodexSegment(segment);
      if (terminated) {
        this.observeOversizedCodexLine();
        events.push({
          observation: {},
          diagnostic: { kind: "oversized" },
        });
        this.resetOversizedLine();
      }
      return;
    }

    const size = this.pending.byteLength + segment.byteLength;
    // Retain one possible CR framing byte until the line is complete.
    if (size > this.parseLimit + 1) {
      this.rememberOversizedCodexSegment(this.pending);
      this.rememberOversizedCodexSegment(segment);
      this.pending = new Uint8Array();
      if (terminated) {
        this.observeOversizedCodexLine();
        events.push({
          observation: {},
          diagnostic: { kind: "oversized" },
        });
      } else {
        this.discardingOversized = true;
      }
      if (terminated) this.resetOversizedLine();
      return;
    }

    this.pending = concatBytes(this.pending, segment);
    if (terminated) {
      if (this.pendingJsonBytes() > this.parseLimit) {
        this.rememberOversizedCodexSegment(this.pending);
        this.observeOversizedCodexLine();
        events.push({
          observation: {},
          diagnostic: { kind: "oversized" },
        });
        this.resetOversizedLine();
      } else {
        const parsed = this.parseLine(
          this.pending,
          !resultLineRejected,
        );
        if (parsed !== undefined) {
          events.push(parsed);
        }
      }
      this.pending = new Uint8Array();
    }
  }

  private pendingJsonBytes(): number {
    return this.pending.byteLength
      - (this.pending.at(-1) === 0x0d ? 1 : 0);
  }

  private parseLine(
    bytes: Uint8Array,
    allowClaudeResult = true,
  ): ParsedMachineEvent | undefined {
    let text: string;
    try {
      text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    } catch {
      return {
        observation: {},
        diagnostic: { kind: "malformed" },
      };
    }
    if (text.endsWith("\r")) {
      text = text.slice(0, -1);
    }
    if (text.trim() === "") {
      return undefined;
    }
    let value: unknown;
    try {
      value = JSON.parse(text);
    } catch {
      return {
        observation: {},
        diagnostic: { kind: "malformed" },
      };
    }
    this.observeCodexExecution(value);
    if (
      allowClaudeResult
      && this.reviewer === "claude"
      && isClaudeResultEvent(value)
    ) {
      this.lastClaudeResultEvent = text;
    }
    const observation = observeMachineEvent(this.reviewer, value);
    return {
      observation,
      ...(observation.diagnostic === "unknown"
        ? { diagnostic: { kind: "unknown" as const } }
        : {}),
    };
  }

  private observeCodexExecution(value: unknown): void {
    if (this.reviewer !== "codex" || !isRecord(value) || typeof value.type !== "string") return;
    if (value.type === "error") {
      this.codexSignal.sawError = true;
      this.noteSandboxDiagnostic(value.message);
      return;
    }
    if (value.type === "turn.failed") {
      this.codexSignal.sawTurnFailed = true;
      this.noteSandboxDiagnostic(value.error);
      return;
    }
    if (!isRecord(value.item) || value.item.type !== "command_execution") return;

    const item = value.item;
    // A command that was launched can have a non-zero exit code, but it still
    // read the brief. A spawn failure has no numeric exit code and must not
    // satisfy the fail-closed command-count check.
    if (value.type === "item.completed" && typeof item.exit_code === "number") {
      this.codexSignal.commandExecutions++;
      return;
    }
    // Only failed/unlaunched command items may expose their output as Codex's
    // own diagnostic. Never inspect a completed command's aggregated output:
    // `cat <brief>` contains reviewed, attacker-controlled diff text.
    if (
      value.type === "item.completed"
      && (typeof item.exit_code !== "number" || item.status !== "completed")
    ) {
      this.noteSandboxDiagnostic(item.aggregated_output);
      this.noteSandboxDiagnostic(item.error);
    }
  }

  private rememberOversizedCodexSegment(segment: Uint8Array): void {
    if (this.reviewer !== "codex" || segment.byteLength === 0) return;
    this.oversizedCodexHead = appendHead(
      this.oversizedCodexHead,
      segment,
      OVERSIZED_CODEX_SIGNAL_BYTES,
    );
    this.oversizedCodexTail = appendTail(
      this.oversizedCodexTail,
      segment,
      OVERSIZED_CODEX_SIGNAL_BYTES,
    );
  }

  private observeOversizedCodexLine(): void {
    if (this.reviewer !== "codex") return;
    // Oversized lines are intentionally never parsed as JSON or scanned for
    // diagnostics: their middle is reviewed content. Codex writes command
    // output before `exit_code` and `status` (pinned by
    // test/fixtures/codex-command-completed-0.163.0.json), so these bounded
    // envelope checks recognize only a completed command that demonstrably ran.
    const head = new TextDecoder().decode(this.oversizedCodexHead);
    const tail = new TextDecoder().decode(this.oversizedCodexTail);
    if (isOversizedCompletedCommand(head, tail)) {
      this.codexSignal.commandExecutions++;
    } else {
      // An oversized record cannot be safely parsed or searched: its middle
      // may be the reviewed diff. Only the positively recognized command
      // envelope above may satisfy the execution requirement.
      this.codexSignal.unclassifiedOversized = true;
    }
  }

  private resetOversizedLine(): void {
    this.discardingOversized = false;
    this.oversizedCodexHead = new Uint8Array();
    this.oversizedCodexTail = new Uint8Array();
  }

  private noteSandboxDiagnostic(value: unknown): void {
    if (sandboxUnavailable(diagnosticText(value))) {
      this.codexSignal.sandboxUnavailable = true;
    }
  }

  private consumeClaudeResultSegment(
    segment: Uint8Array,
    terminated: boolean,
  ): boolean {
    if (this.reviewer !== "claude") {
      return false;
    }
    if (!this.discardingOversizedClaudeResult) {
      // Keep one extra byte until line completion because CRLF framing places
      // a trailing CR before the LF supplied separately by push().
      if (this.claudeResultBytes + segment.byteLength > this.resultLimit + 1) {
        this.claudeResultSegments = [];
        this.claudeResultBytes = 0;
        this.discardingOversizedClaudeResult = true;
      } else if (segment.byteLength > 0) {
        this.claudeResultSegments.push(Uint8Array.from(segment));
        this.claudeResultBytes += segment.byteLength;
      }
    }
    if (terminated) {
      return this.finishClaudeResultLine();
    }
    return false;
  }

  private finishClaudeResultLine(): boolean {
    if (this.reviewer !== "claude") {
      return false;
    }
    const lastSegment = this.claudeResultSegments.at(-1);
    const hasFramingCr = lastSegment !== undefined
      && lastSegment.at(-1) === 0x0d;
    const jsonBytes = this.claudeResultBytes - (hasFramingCr ? 1 : 0);
    let rejected = false;
    if (
      this.discardingOversizedClaudeResult
      || jsonBytes > this.resultLimit
    ) {
      // A later line too large to classify must invalidate any cached result;
      // publishing an earlier success would be less safe than failing closed.
      this.lastClaudeResultEvent = undefined;
      rejected = true;
    } else if (this.claudeResultBytes > 0) {
      if (this.claudeResultBytes <= this.parseLimit) {
        // parseLine already needs the value for safe activity metadata.
      } else {
        const bytes = new Uint8Array(this.claudeResultBytes);
        let offset = 0;
        for (const segment of this.claudeResultSegments) {
          bytes.set(segment, offset);
          offset += segment.byteLength;
        }
        try {
          let text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
          if (text.endsWith("\r")) {
            text = text.slice(0, -1);
          }
          const value: unknown = JSON.parse(text);
          if (isClaudeResultEvent(value)) {
            this.lastClaudeResultEvent = text;
          }
        } catch {
          // Match direct unwrapClaudeStream: malformed non-result lines do not
          // replace the last valid result.
        }
      }
    }
    this.claudeResultSegments = [];
    this.claudeResultBytes = 0;
    this.discardingOversizedClaudeResult = false;
    return rejected;
  }
}

class SandboxUnavailableDetector {
  private carry = "";

  observe(bytes: Uint8Array): boolean {
    const text = this.carry + new TextDecoder().decode(bytes);
    this.carry = text.slice(-256);
    return sandboxUnavailable(text);
  }
}

function sandboxUnavailable(text: string): boolean {
  return /Refusing to create helper binaries|Unable to spawn codex-linux-sandbox/i.test(text);
}

function isOversizedCompletedCommand(head: string, tail: string): boolean {
  // Codex's JSON event envelope starts with the top-level type and its command
  // item has an early `type` field. Anchoring at the opening object avoids
  // accepting lookalike strings embedded in reviewed command output.
  const completedCommand = /^\s*\{\s*"type"\s*:\s*"item\.completed"\s*,\s*"item"\s*:\s*\{[^{}]*"type"\s*:\s*"command_execution"/
    .test(head);
  // `aggregated_output` precedes these final item fields in Codex's stream.
  // Requiring the closing item/event braces means an incomplete oversized line
  // cannot satisfy the command requirement.
  const finishedCommand = /"exit_code"\s*:\s*-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?\s*,\s*"status"\s*:\s*"[^"]+"\s*}\s*}\s*\r?$/
    .test(tail);
  return completedCommand && finishedCommand;
}

function appendHead(current: Uint8Array, next: Uint8Array, limit: number): Uint8Array {
  if (current.byteLength >= limit || next.byteLength === 0) return current;
  const take = Math.min(limit - current.byteLength, next.byteLength);
  const combined = new Uint8Array(current.byteLength + take);
  combined.set(current);
  combined.set(next.subarray(0, take), current.byteLength);
  return combined;
}

function appendTail(current: Uint8Array, next: Uint8Array, limit: number): Uint8Array {
  if (next.byteLength >= limit) {
    return Uint8Array.from(next.subarray(next.byteLength - limit));
  }
  const retained = Math.min(current.byteLength, limit - next.byteLength);
  const combined = new Uint8Array(retained + next.byteLength);
  if (retained > 0) combined.set(current.subarray(current.byteLength - retained));
  combined.set(next, retained);
  return combined;
}

// Keep classification scoped to known diagnostic fields. In particular, do not
// serialize an event: machine events often include command output copied from
// the untrusted review brief.
function diagnosticText(value: unknown): string {
  if (typeof value === "string") return value;
  if (isRecord(value) && typeof value.message === "string") return value.message;
  return "";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function concatBytes(
  left: Uint8Array<ArrayBufferLike>,
  right: Uint8Array<ArrayBufferLike>,
): Uint8Array<ArrayBufferLike> {
  if (left.byteLength === 0) {
    return Uint8Array.from(right);
  }
  if (right.byteLength === 0) {
    return left;
  }
  const combined = new Uint8Array(left.byteLength + right.byteLength);
  combined.set(left);
  combined.set(right, left.byteLength);
  return combined;
}
