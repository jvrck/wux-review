import { describe, expect, test } from "bun:test";
import { DEFAULT_CHECK, resolveCheck, runCheck, type RunCommand } from "../../src/review/check";

describe("resolveCheck", () => {
  test("returns the configured check commands when set", () => {
    expect(resolveCheck({ check: ["pytest -q"] })).toEqual(["pytest -q"]);
    expect(resolveCheck({ check: ["ruff check", "pytest -q"] })).toEqual(["ruff check", "pytest -q"]);
  });

  test("falls back to the Bun default when absent", () => {
    expect(resolveCheck({})).toEqual(DEFAULT_CHECK);
    expect(DEFAULT_CHECK).toEqual(["bun run typecheck && bun test"]);
  });
});

describe("runCheck", () => {
  test("runs commands in order and returns 0 when all pass", async () => {
    const seen: string[] = [];
    const run: RunCommand = async (c) => {
      seen.push(c);
      return 0;
    };
    expect(await runCheck(["a", "b", "c"], run)).toBe(0);
    expect(seen).toEqual(["a", "b", "c"]);
  });

  test("stops at the first failure and returns its exit code (fail-fast)", async () => {
    const seen: string[] = [];
    const run: RunCommand = async (c) => {
      seen.push(c);
      return c === "b" ? 3 : 0;
    };
    expect(await runCheck(["a", "b", "c"], run)).toBe(3);
    expect(seen).toEqual(["a", "b"]); // "c" is never reached
  });

  test("the real runner executes a non-Bun shell command and reports its status", async () => {
    // Proves a non-Bun repo's check works end to end (no Bun involved).
    expect(await runCheck(["true"])).toBe(0);
    expect(await runCheck(["exit 4"])).toBe(4);
    expect(await runCheck(["echo first", "false", "echo unreached"])).toBe(1);
  });
});
