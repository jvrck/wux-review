import { describe, expect, test } from "bun:test";
import { describeTarget, resolveTarget } from "../../src/review/target";

describe("resolveTarget", () => {
  test("--pr wins and yields a pr target", () => {
    expect(resolveTarget({ pr: 42 })).toEqual({ kind: "pr", pr: 42 });
  });

  test("an explicit range is used verbatim (two- and three-dot)", () => {
    expect(resolveTarget({ ref: "main..HEAD" })).toEqual({ kind: "range", range: "main..HEAD" });
    expect(resolveTarget({ ref: "a...b" })).toEqual({ kind: "range", range: "a...b" });
  });

  test("a single ref becomes a three-dot range against HEAD", () => {
    expect(resolveTarget({ ref: "HEAD~1" })).toEqual({ kind: "range", range: "HEAD~1...HEAD" });
    expect(resolveTarget({ ref: "abc123" })).toEqual({ kind: "range", range: "abc123...HEAD" });
  });

  test("no ref is the working-tree target", () => {
    expect(resolveTarget({})).toEqual({ kind: "worktree" });
  });
});

describe("describeTarget", () => {
  test("renders each kind", () => {
    expect(describeTarget({ kind: "pr", pr: 7 })).toBe("PR #7");
    expect(describeTarget({ kind: "range", range: "main..HEAD" })).toBe("main..HEAD");
    expect(describeTarget({ kind: "worktree" })).toBe("working tree");
  });
});
