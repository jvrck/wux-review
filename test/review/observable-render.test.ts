import { describe, expect, test } from "bun:test";
import {
  initialObservablePaneState,
  observeMachineEvent,
  renderObservablePane,
} from "../../src/review/observable-render";

const FORBIDDEN = [
  "SESSION_SECRET",
  "CHAIN_OF_THOUGHT_DO_NOT_RENDER",
  "PROMPT_AND_DIFF_PAYLOAD_DO_NOT_RENDER",
  "TOKEN_SECRET",
  "TOOL_RESULT_SECRET",
  "UNKNOWN_EVENT_SECRET",
  "TOKEN_USAGE_SECRET",
  "THREAD_SECRET",
  "REASONING_CONTENT_DO_NOT_RENDER",
  "PROMPT_DIFF_TOKEN_SECRET",
  "TOOL_OUTPUT_SECRET",
  "UNKNOWN_CODEX_SECRET",
  "CODEX_TOKEN_SECRET",
];

describe("observable safe activity renderer", () => {
  test("Claude renders only fixed lifecycle/tool metadata", async () => {
    const fixture = await Bun.file(
      new URL("../fixtures/observable/claude-stream.jsonl", import.meta.url),
    ).text();
    const state = initialObservablePaneState({
      reviewId: "review112",
      round: 2,
      reviewer: "claude",
      attempt: 1,
      childName: "wuxr-review112-r2-claude",
      resultId: "result-id",
      at: "2026-07-28T00:00:00Z",
    });

    for (const [index, line] of fixture.trimEnd().split("\n").entries()) {
      const observation = observeMachineEvent("claude", JSON.parse(line));
      if (observation.phase !== undefined) state.phase = observation.phase;
      if (observation.latestActivity !== undefined) {
        state.latestActivity = observation.latestActivity;
      }
      if (observation.diagnostic === "unknown") state.diagnostics.unknown += 1;
      state.updatedAt = `2026-07-28T00:00:0${index + 1}Z`;
      state.lastActivityAt = state.updatedAt;
    }

    const pane = renderObservablePane(state, "2026-07-28T00:00:08Z");
    expect(pane).toContain("review review112 · round 2 · leg claude · attempt 1");
    expect(pane).toContain("state starting · elapsed 8s · last activity 3s ago");
    expect(pane).toContain("phase finalizing · latest model result received");
    expect(pane).toContain("result pending");
    expect(pane).toContain("diagnostics 1");
    for (const secret of FORBIDDEN) expect(pane).not.toContain(secret);
  });

  test("Codex reasoning, commands, outputs, ids, usage, and unknown fields stay out", async () => {
    const fixture = await Bun.file(
      new URL("../fixtures/observable/codex-stream.jsonl", import.meta.url),
    ).text();
    const safe: string[] = [];
    for (const line of fixture.trimEnd().split("\n")) {
      const observation = observeMachineEvent("codex", JSON.parse(line));
      safe.push(JSON.stringify(observation));
    }
    const rendered = safe.join("\n");
    expect(rendered).toContain("session initialized");
    expect(rendered).toContain("model activity completed");
    expect(rendered).toContain("shell tool started");
    expect(rendered).toContain("turn completed");
    for (const secret of FORBIDDEN) expect(rendered).not.toContain(secret);
  });

  test("arbitrary tool names and malformed shapes never cross the allowlist", () => {
    const hostile = observeMachineEvent("claude", {
      type: "assistant",
      message: {
        content: [{
          type: "tool_use",
          name: "TOKEN_SECRET_EXFILTRATION",
          input: { prompt: "PROMPT_AND_DIFF_PAYLOAD_DO_NOT_RENDER" },
        }],
      },
    });
    expect(hostile).toEqual({
      phase: "reviewing",
      latestActivity: "tool activity",
    });
    expect(observeMachineEvent("codex", { type: "item.started", item: { type: "SECRET_ITEM" } }))
      .toEqual({ diagnostic: "unknown" });
    expect(observeMachineEvent("claude", "not an event"))
      .toEqual({ diagnostic: "unknown" });
  });

  test("prototype-inherited names cannot bypass either allowlist", () => {
    for (const name of ["toString", "constructor", "__proto__"]) {
      expect(observeMachineEvent("claude", {
        type: "assistant",
        message: { content: [{ type: "tool_use", name }] },
      })).toEqual({
        phase: "reviewing",
        latestActivity: "tool activity",
      });
      expect(observeMachineEvent("codex", {
        type: "item.started",
        item: { type: name },
      })).toEqual({ diagnostic: "unknown" });
    }
  });

  test("only atomic publication moves result metadata from pending to final", () => {
    const state = initialObservablePaneState({
      reviewId: "review112",
      round: 1,
      reviewer: "codex",
      attempt: 1,
      childName: "child",
      resultId: "result-id",
      at: "2026-07-28T00:00:00Z",
    });
    const event = observeMachineEvent("codex", {
      type: "turn.completed",
      verdict: "approve",
      result: "MUST_NOT_BECOME_AUTHORITATIVE",
    });
    state.phase = event.phase!;
    state.latestActivity = event.latestActivity!;
    expect(renderObservablePane(state)).toContain("result pending");

    state.status = "completed";
    state.result = {
      state: "final",
      code: 0,
      timedOut: false,
      resultId: "result-id",
    };
    expect(renderObservablePane(state)).toContain("result final · exit 0");
  });
});
