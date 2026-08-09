import { describe, expect, test } from "bun:test";
import { endSession } from "../../src/review/session";
import type { SessionStore } from "../../src/review/session-state";
import type { Run, RunResult } from "../../src/runtime/exec";

const ok: RunResult = { code: 0, stdout: "", stderr: "" };

// A store spy that records the sessions it was asked to clear.
function spyStore(): SessionStore & { cleared: string[] } {
  const cleared: string[] = [];
  return {
    cleared,
    async load() {
      return undefined;
    },
    async save() {},
    async clear(id) {
      cleared.push(id);
    },
  };
}

describe("endSession", () => {
  test("stops both reviewer sessions for the id", async () => {
    const calls: string[] = [];
    const run: Run = async (cmd) => {
      calls.push(cmd.join(" "));
      return ok;
    };
    await endSession("abc-1", run, spyStore());
    expect(calls).toContain("wux --local stop wuxr-abc-1-claude --yes");
    expect(calls).toContain("wux --local stop wuxr-abc-1-codex --yes");
  });

  test("clears the persisted per-session prior-findings state (#91)", async () => {
    const store = spyStore();
    await endSession("abc-1", async () => ok, store);
    expect(store.cleared).toEqual(["abc-1"]);
  });

  test("a state-clear failure does not mask a successful session stop", async () => {
    const store = spyStore();
    store.clear = async () => {
      throw new Error("disk gone");
    };
    // The wux stops succeed, and the best-effort clear failure is swallowed.
    await expect(endSession("abc-1", async () => ok, store)).resolves.toBeUndefined();
  });

  test("throws when a stop genuinely fails (never silently reports success)", async () => {
    const run: Run = async (cmd) =>
      cmd.join(" ").includes("claude")
        ? { code: 1, stdout: "", stderr: "tmux error: permission denied" }
        : ok;
    await expect(endSession("abc", run)).rejects.toThrow("failed to stop");
  });

  test("treats an already-gone session as successful cleanup", async () => {
    const run: Run = async () => ({ code: 1, stdout: "", stderr: "wux: tmux session is not running" });
    await expect(endSession("abc", run)).resolves.toBeUndefined();
  });

  test("attempts both stops even if the first rejects, and surfaces the failure", async () => {
    const calls: string[] = [];
    const run: Run = async (cmd) => {
      calls.push(cmd.join(" "));
      if (cmd.join(" ").includes("claude")) {
        throw new Error("spawn ENOENT");
      }
      return ok;
    };
    await expect(endSession("abc", run)).rejects.toThrow("failed to stop");
    expect(calls).toContain("wux --local stop wuxr-abc-claude --yes");
    expect(calls).toContain("wux --local stop wuxr-abc-codex --yes"); // attempted despite the first throwing
  });

  test("a real failure containing an unrelated 'not found' is NOT swallowed as benign", async () => {
    const run: Run = async () => ({ code: 127, stdout: "", stderr: "wux: command not found" });
    await expect(endSession("abc", run)).rejects.toThrow("failed to stop");
  });

  test("rejects an unsafe session id before running anything", async () => {
    const calls: string[] = [];
    const run: Run = async (cmd) => {
      calls.push(cmd.join(" "));
      return ok;
    };
    await expect(endSession("../etc", run)).rejects.toThrow("invalid session id");
    expect(calls).toHaveLength(0);
  });
});
