import { describe, expect, test } from "bun:test";
import { WUX_ALREADY_GONE_PATTERNS } from "../../src/backends/observable";
import { isAlreadyGone, endSession } from "../../src/review/session";
import type { ObservableRoundRecord, ObservableRoundStore } from "../../src/review/observable-lifecycle";
import type { SessionStore } from "../../src/review/session-state";
import type { SessionState } from "../../src/review/types";
import type { Run, RunResult } from "../../src/runtime/exec";
import { WuxReviewError } from "../../src/runtime/errors";

const ok: RunResult = { code: 0, stdout: "", stderr: "" };
const release = async () => {};
const lock = async () => release;

function child(reviewer: "claude" | "codex", attempt = 1): string {
  return `wuxr-abc-r1-xdeadbeef-${reviewer}${attempt === 1 ? "" : `-a${attempt}`}`;
}

function state(children: SessionState["children"] = []): SessionState {
  return {
    version: 1,
    round: 1,
    results: {
      claude: { reviewer: "claude", findings: [], verdict: "approve" },
      codex: { reviewer: "codex", findings: [], verdict: "approve" },
    },
    sticky: { claude: [], codex: [] },
    ledger: { claude: [], codex: [] },
    children,
  };
}

function store(current: SessionState | undefined = undefined): SessionStore & { cleared: string[] } {
  const cleared: string[] = [];
  return {
    cleared,
    async load() { return current; },
    async save() {},
    async clear(id) { cleared.push(id); },
  };
}

function journal(overrides: Partial<ObservableRoundRecord> = {}): ObservableRoundRecord {
  return {
    version: 1,
    reviewId: "abc",
    round: 1,
    executionId: "deadbeef",
    sessionMode: true,
    priorStateSha256: null,
    expected: { claudeChildName: child("claude"), codexChildName: child("codex") },
    prepared: { claude: [child("claude")], codex: [child("codex")] },
    ledger: { claude: [], codex: [] },
    evidence: { claude: [], codex: [] },
    state: "completed",
    startedAt: "2026-10-19T00:00:00.000Z",
    updatedAt: "2026-10-19T00:00:00.000Z",
    ...overrides,
  };
}

function roundStore(current: ObservableRoundRecord | undefined = undefined): ObservableRoundStore & { cleared: string[] } {
  const cleared: string[] = [];
  return {
    cleared,
    async load() { return current; },
    async save() {},
    async clear(id) { cleared.push(id); },
    async prune() {},
  };
}

describe("endSession", () => {
  test("stops exact state-recorded children, including Codex retry, never legacy observable guesses", async () => {
    const calls: string[] = [];
    const run: Run = async (cmd) => { calls.push(cmd.join(" ")); return ok; };
    const persisted = state([{
      round: 1,
      claude: [{ reviewer: "claude", childName: child("claude"), attempt: 1, evidencePath: "/e", resultPath: "/r", resultId: "id", promptSha256: "a".repeat(64) }],
      codex: [
        { reviewer: "codex", childName: child("codex"), attempt: 1, evidencePath: "/e", resultPath: "/r", resultId: "id", promptSha256: "a".repeat(64) },
        { reviewer: "codex", childName: child("codex", 2), attempt: 2, evidencePath: "/e", resultPath: "/r", resultId: "id", promptSha256: "a".repeat(64) },
      ],
    }]);
    await endSession("abc", run, store(persisted), { roundStore: roundStore(), acquireLock: lock });
    expect(calls).toEqual([
      `wux --local stop ${child("claude")} --yes`,
      `wux --local stop ${child("codex")} --yes`,
      `wux --local stop ${child("codex", 2)} --yes`,
    ]);
    expect(calls.join(" ")).not.toContain("wuxr-abc-claude");
    expect(calls.join(" ")).not.toContain("wuxr-abc-codex");
  });

  test("uses legacy names only when persisted state proves a direct round ran", async () => {
    const calls: string[] = [];
    await endSession("abc", async (cmd) => { calls.push(cmd[3]!); return ok; }, store(state()), {
      roundStore: roundStore(), acquireLock: lock,
    });
    expect(calls).toEqual(["wuxr-abc-claude", "wuxr-abc-codex"]);
  });

  test("uses journal expected and prepared names after interruption before session save", async () => {
    const calls: string[] = [];
    const current = journal({ prepared: { claude: [child("claude")], codex: [child("codex"), child("codex", 2)] } });
    await endSession("abc", async (cmd) => { calls.push(cmd[3]!); return ok; }, store(), {
      roundStore: roundStore(current), acquireLock: lock,
    });
    expect(calls).toEqual([child("claude"), child("codex"), child("codex", 2)]);
  });

  test("already-gone children succeed and clear both stores", async () => {
    const sessions = store(state([{ round: 1, claude: [], codex: [] }]));
    const rounds = roundStore(journal());
    const report = await endSession("abc", async () => ({ code: 1, stdout: "", stderr: "wux: run not found: child" }), sessions, {
      roundStore: rounds, acquireLock: lock,
    });
    expect(report.children.map((entry) => entry.status)).toEqual(["already-gone", "already-gone"]);
    expect(sessions.cleared).toEqual(["abc"]);
    expect(rounds.cleared).toEqual(["abc"]);
  });

  test("reports the state journal and tmp files removed after successful cleanup", async () => {
    const sessions = store(state([{ round: 1, claude: [], codex: [] }]));
    sessions.inspectForEndSession = async () => ({
      state: await sessions.load("abc"),
      files: ["/sessions/abc.json", "/sessions/abc.json.tmp"],
    });
    const rounds = roundStore(journal());
    rounds.inspectForEndSession = async () => ({
      record: await rounds.load("abc"),
      files: ["/rounds/abc.json", "/rounds/abc.json.tmp"],
    });
    const report = await endSession("abc", async () => ok, sessions, { roundStore: rounds, acquireLock: lock });
    expect(report.removed).toEqual([
      "/sessions/abc.json",
      "/sessions/abc.json.tmp",
      "/rounds/abc.json",
      "/rounds/abc.json.tmp",
    ]);
  });

  test("a genuine failure attempts every child and keeps both stores", async () => {
    const sessions = store(state([{ round: 1, claude: [], codex: [] }]));
    const rounds = roundStore(journal());
    const calls: string[] = [];
    await expect(endSession("abc", async (cmd) => {
      calls.push(cmd[3]!);
      return cmd[3] === child("claude") ? { code: 1, stdout: "", stderr: "permission denied" } : ok;
    }, sessions, { roundStore: rounds, acquireLock: lock })).rejects.toThrow(`${child("claude")}: failed: permission denied`);
    expect(calls).toEqual([child("claude"), child("codex")]);
    expect(sessions.cleared).toEqual([]);
    expect(rounds.cleared).toEqual([]);
  });

  test("with no state or journal it attempts no stops and reports nothing recorded", async () => {
    const calls: string[] = [];
    const report = await endSession("abc", async (cmd) => { calls.push(cmd.join(" ")); return ok; }, store(), {
      roundStore: roundStore(), acquireLock: lock,
    });
    expect(report.nothingRecorded).toBe(true);
    expect(calls).toEqual([]);
  });

  test("refuses a tampered child name without stopping it", async () => {
    const sessions = store(state([{
      round: 1,
      claude: [{ reviewer: "claude", childName: "unrelated-run", attempt: 1, evidencePath: "/e", resultPath: "/r", resultId: "id", promptSha256: "a".repeat(64) }],
      codex: [],
    }]));
    let calls = 0;
    await expect(endSession("abc", async () => { calls++; return ok; }, sessions, {
      roundStore: roundStore(), acquireLock: lock,
    })).rejects.toThrow("unrelated-run");
    expect(calls).toBe(0);
    expect(sessions.cleared).toEqual([]);
  });

  test("refuses a legacy-shaped name injected into observable child evidence", async () => {
    const sessions = store(state([{
      round: 1,
      claude: [{ reviewer: "claude", childName: "wuxr-abc-claude", attempt: 1, evidencePath: "/e", resultPath: "/r", resultId: "id", promptSha256: "a".repeat(64) }],
      codex: [],
    }]));
    await expect(endSession("abc", async () => ok, sessions, {
      roundStore: roundStore(), acquireLock: lock,
    })).rejects.toThrow("invalid observable child name");
  });

  test("leaves an unreadable state in place and surfaces a typed error naming it", async () => {
    const sessions = store();
    sessions.inspectForEndSession = async () => {
      throw new WuxReviewError("--end-session: invalid session state at /sessions/abc.json");
    };
    await expect(endSession("abc", async () => ok, sessions, {
      roundStore: roundStore(), acquireLock: lock,
    })).rejects.toThrow("/sessions/abc.json");
    await expect(endSession("abc", async () => ok, sessions, {
      roundStore: roundStore(), acquireLock: lock,
    })).rejects.toBeInstanceOf(WuxReviewError);
    expect(sessions.cleared).toEqual([]);
  });

  test("refuses a non-terminal journal without stopping", async () => {
    let calls = 0;
    await expect(endSession("abc", async () => { calls++; return ok; }, store(), {
      roundStore: roundStore(journal({ state: "running" })), acquireLock: lock,
    })).rejects.toThrow("wux-review reconcile abc");
    expect(calls).toBe(0);
  });

  test("waits for the shared per-session lock before reading state", async () => {
    let locked = false;
    const acquireLock = async () => {
      locked = true;
      return release;
    };
    const sessions = store();
    sessions.load = async () => {
      expect(locked).toBe(true);
      return undefined;
    };
    await endSession("abc", async () => ok, sessions, { roundStore: roundStore(), acquireLock });
  });
});

test("isAlreadyGone accepts exactly the observable backend's missing-run patterns", () => {
  for (const pattern of WUX_ALREADY_GONE_PATTERNS) {
    const source = pattern.source.replace(/^\^/, "").replace(/\(\?:[^)]*\)/g, "stopped").replace(/\$$/, "");
    // Concrete known wording covers the shared list's externally observable contract.
    expect(isAlreadyGone({ code: 1, stdout: "", stderr: source.includes("not found") ? "run not found: x" : "run is stopped" })).toBe(true);
  }
  expect(isAlreadyGone({ code: 127, stdout: "", stderr: "wux: command not found" })).toBe(false);
});
