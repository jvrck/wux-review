import type { ReviewerName } from "./types";

export type ObservableLegState =
  | "starting"
  | "running"
  | "collecting"
  | "completed"
  | "timed-out"
  | "failed"
  | "tainted"
  | "interrupted"
  | "reconciled";

export interface ObservableDiagnostics {
  malformed: number;
  oversized: number;
  unknown: number;
  renderer: number;
}

export interface ObservablePaneState {
  version: 2;
  reviewId: string;
  round: number;
  reviewer: ReviewerName;
  attempt: number;
  childName: string;
  status: ObservableLegState;
  startedAt: string;
  updatedAt: string;
  lastActivityAt: string;
  phase: string;
  latestActivity: string;
  result: {
    state: "pending" | "final";
    code: number | null;
    timedOut: boolean;
    resultId: string;
  };
  diagnostics: ObservableDiagnostics;
}

export interface SafeEventObservation {
  phase?: string;
  latestActivity?: string;
  diagnostic?: "unknown";
}

// Maps, rather than plain object indexing, make inherited names (`toString`,
// `constructor`, `__proto__`) impossible allowlist hits.
const CLAUDE_TOOL_LABELS = new Map<string, string>([
  ["Bash", "shell tool"],
  ["Edit", "file tool"],
  ["Glob", "file search"],
  ["Grep", "code search"],
  ["NotebookEdit", "notebook tool"],
  ["Read", "file read"],
  ["Task", "subtask"],
  ["TodoWrite", "plan update"],
  ["WebFetch", "web fetch"],
  ["WebSearch", "web search"],
  ["Write", "file tool"],
]);

const CODEX_ITEM_LABELS = new Map<string, string>([
  ["agent_message", "assistant update"],
  ["command_execution", "shell tool"],
  ["error", "tool error"],
  ["file_change", "file tool"],
  ["mcp_tool_call", "MCP tool"],
  ["reasoning", "model activity"],
  ["todo_list", "plan update"],
  ["web_search", "web search"],
]);

// Turn one parsed machine event into fixed, non-payload activity metadata. This
// function deliberately never interpolates event text, commands, paths, tool
// inputs/results, token data, arbitrary type names, or reasoning content.
export function observeMachineEvent(
  reviewer: ReviewerName,
  value: unknown,
): SafeEventObservation {
  if (!isRecord(value) || typeof value.type !== "string") {
    return { diagnostic: "unknown" };
  }
  return reviewer === "claude"
    ? observeClaudeEvent(value)
    : observeCodexEvent(value);
}

export function initialObservablePaneState(input: {
  reviewId: string;
  round: number;
  reviewer: ReviewerName;
  attempt: number;
  childName: string;
  resultId: string;
  at: string;
}): ObservablePaneState {
  return {
    version: 2,
    reviewId: input.reviewId,
    round: input.round,
    reviewer: input.reviewer,
    attempt: input.attempt,
    childName: input.childName,
    status: "starting",
    startedAt: input.at,
    updatedAt: input.at,
    lastActivityAt: input.at,
    phase: "launching",
    latestActivity: "leg launched",
    result: {
      state: "pending",
      code: null,
      timedOut: false,
      resultId: input.resultId,
    },
    diagnostics: {
      malformed: 0,
      oversized: 0,
      unknown: 0,
      renderer: 0,
    },
  };
}

export function renderObservablePane(
  state: ObservablePaneState,
  at: string = state.updatedAt,
): string {
  const elapsed = ageSeconds(state.startedAt, at);
  const activityAge = ageSeconds(state.lastActivityAt, at);
  const result = state.result.state === "pending"
    ? "pending"
    : `final · exit ${state.result.code === null ? "none" : state.result.code}`;
  const diagnostics = Object.values(state.diagnostics).reduce((sum, count) => sum + count, 0);
  return [
    `review ${state.reviewId} · round ${state.round} · leg ${state.reviewer} · attempt ${state.attempt}`,
    `state ${state.status} · elapsed ${elapsed}s · last activity ${activityAge}s ago`,
    `phase ${state.phase} · latest ${state.latestActivity}`,
    `result ${result}${diagnostics === 0 ? "" : ` · diagnostics ${diagnostics}`}`,
    "",
  ].join("\n");
}

function observeClaudeEvent(event: Record<string, unknown>): SafeEventObservation {
  switch (event.type) {
    case "system":
      return observeClaudeSystem(event.subtype);
    case "assistant": {
      const message = isRecord(event.message) ? event.message : undefined;
      const content = Array.isArray(message?.content) ? message.content : [];
      const tool = content.find(
        (block) => isRecord(block) && block.type === "tool_use",
      );
      if (isRecord(tool)) {
        return {
          phase: "reviewing",
          latestActivity: claudeToolLabel(tool.name),
        };
      }
      return { phase: "reviewing", latestActivity: "assistant update" };
    }
    case "user": {
      const message = isRecord(event.message) ? event.message : undefined;
      const content = Array.isArray(message?.content) ? message.content : [];
      const hasToolResult = content.some(
        (block) => isRecord(block) && block.type === "tool_result",
      );
      return hasToolResult
        ? { phase: "reviewing", latestActivity: "tool completed" }
        : { phase: "reviewing", latestActivity: "review update" };
    }
    case "stream_event":
      return { phase: "reviewing", latestActivity: "model working" };
    case "tool_progress":
      return { phase: "reviewing", latestActivity: "tool running" };
    case "result":
      return {
        phase: event.is_error === false ? "finalizing" : "failed",
        latestActivity: event.is_error === false ? "model result received" : "model result failed",
      };
    default:
      return { diagnostic: "unknown" };
  }
}

function observeClaudeSystem(subtype: unknown): SafeEventObservation {
  switch (subtype) {
    case "init":
      return { phase: "initializing", latestActivity: "session initialized" };
    case "compact_boundary":
      return { phase: "reviewing", latestActivity: "context compacted" };
    case "hook_started":
    case "hook_progress":
      return { phase: "reviewing", latestActivity: "hook running" };
    case "hook_response":
      return { phase: "reviewing", latestActivity: "hook completed" };
    case "status":
      return { phase: "reviewing", latestActivity: "status update" };
    default:
      return { diagnostic: "unknown" };
  }
}

function observeCodexEvent(event: Record<string, unknown>): SafeEventObservation {
  switch (event.type) {
    case "thread.started":
      return { phase: "initializing", latestActivity: "session initialized" };
    case "turn.started":
      return { phase: "reviewing", latestActivity: "turn started" };
    case "turn.completed":
      return { phase: "finalizing", latestActivity: "turn completed" };
    case "turn.failed":
    case "error":
      return { phase: "failed", latestActivity: "turn failed" };
    case "item.started":
    case "item.updated":
    case "item.completed": {
      const item = isRecord(event.item) ? event.item : undefined;
      const label = typeof item?.type === "string"
        ? CODEX_ITEM_LABELS.get(item.type)
        : undefined;
      if (label === undefined) {
        return { diagnostic: "unknown" };
      }
      const lifecycle = event.type === "item.started"
        ? "started"
        : event.type === "item.completed"
          ? "completed"
          : "updated";
      return {
        phase: "reviewing",
        latestActivity: `${label} ${lifecycle}`,
      };
    }
    default:
      return { diagnostic: "unknown" };
  }
}

function claudeToolLabel(name: unknown): string {
  if (typeof name !== "string") {
    return "tool activity";
  }
  if (name.startsWith("mcp__")) {
    return "MCP tool";
  }
  return CLAUDE_TOOL_LABELS.get(name) ?? "tool activity";
}

function ageSeconds(from: string, to: string): number {
  const start = Date.parse(from);
  const end = Date.parse(to);
  if (!Number.isFinite(start) || !Number.isFinite(end)) {
    return 0;
  }
  return Math.max(0, Math.floor((end - start) / 1000));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
