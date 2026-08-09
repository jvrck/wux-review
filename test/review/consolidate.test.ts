import { describe, expect, test } from "bun:test";
import { consolidate } from "../../src/review/consolidate";
import type { Finding, ReviewerName, ReviewResult, Severity } from "../../src/review/types";

const f = (over: Partial<Finding> = {}): Finding => ({
  lens: "correctness",
  file: "x.ts",
  line: 1,
  severity: "nit",
  finding: "thing",
  ...over,
});

const result = (reviewer: ReviewerName, findings: Finding[]): ReviewResult => ({
  reviewer,
  findings,
  verdict: findings.some((x) => x.severity === "must-fix") ? "block" : "approve",
});

describe("consolidate", () => {
  test("blocks iff there is any must-fix; nits never block", () => {
    const blocked = consolidate(result("claude", [f({ severity: "must-fix" })]), result("codex", []), "s");
    expect(blocked.verdict).toBe("block");

    const approved = consolidate(
      result("claude", [f({ severity: "nice-fix" })]),
      result("codex", [f({ file: "y.ts", severity: "nit" })]),
      "s",
    );
    expect(approved.verdict).toBe("approve");
  });

  test("buckets findings by severity and carries per-reviewer verdicts + session", () => {
    const env = consolidate(
      result("claude", [f({ file: "a", severity: "must-fix" }), f({ file: "b", severity: "nit" })]),
      result("codex", [f({ file: "c", severity: "nice-fix" })]),
      "sess-1",
    );
    expect(env.must_fix).toHaveLength(1);
    expect(env.nice_fix).toHaveLength(1);
    expect(env.nits).toHaveLength(1);
    expect(env.reviewers).toEqual({ claude: "block", codex: "approve" });
    expect(env.session).toBe("sess-1");
    // bucketed findings carry no severity field (implied by the bucket)
    expect(env.must_fix[0]).not.toHaveProperty("severity");
    expect(env.must_fix[0]!.raised_by).toEqual(["claude"]);
  });

  test("dedupes an identical finding from both reviewers and merges raised_by", () => {
    const shared = { file: "x.ts", line: 42, lens: "edge-cases", severity: "nice-fix" as Severity, finding: "Handle empty input" };
    const env = consolidate(result("claude", [f(shared)]), result("codex", [f(shared)]), "s");
    expect(env.nice_fix).toHaveLength(1);
    expect(env.nice_fix[0]!.raised_by).toEqual(["claude", "codex"]);
  });

  test("a merged finding keeps the most severe assessment (either must-fix counts)", () => {
    const shared = { file: "x.ts", line: 7, lens: "security", finding: "Validate the token" };
    const env = consolidate(
      result("claude", [f({ ...shared, severity: "nice-fix" })]),
      result("codex", [f({ ...shared, severity: "must-fix" })]),
      "s",
    );
    expect(env.verdict).toBe("block");
    expect(env.must_fix).toHaveLength(1);
    expect(env.must_fix[0]!.raised_by).toEqual(["claude", "codex"]);
    expect(env.nice_fix).toHaveLength(0);
  });

  test("retains each reviewer's own severity on a merged mixed-severity finding (consolidated stays max)", () => {
    const shared = { file: "x.ts", line: 7, lens: "security", finding: "Validate the token" };
    const env = consolidate(
      result("claude", [f({ ...shared, severity: "nice-fix" })]),
      result("codex", [f({ ...shared, severity: "must-fix" })]),
      "s",
    );
    // consolidated bucket is still the max (must-fix) — verdict + --json unchanged
    expect(env.must_fix).toHaveLength(1);
    // …but each reviewer's OWN severity is retained for per-agent comment bucketing
    expect(env.must_fix[0]!.perReviewer).toEqual({ claude: "nice-fix", codex: "must-fix" });
  });

  test("records only the raising reviewer's severity for a single-reviewer finding", () => {
    const env = consolidate(result("claude", [f({ severity: "must-fix" })]), result("codex", []), "s");
    expect(env.must_fix[0]!.perReviewer).toEqual({ claude: "must-fix" });
  });

  test("v1 does NOT promote a nit both reviewers happen to raise", () => {
    const shared = { file: "x.ts", line: 3, lens: "clarity", severity: "nit" as Severity, finding: "rename foo" };
    const env = consolidate(result("claude", [f(shared)]), result("codex", [f(shared)]), "s");
    expect(env.verdict).toBe("approve");
    expect(env.nits).toHaveLength(1);
    expect(env.must_fix).toHaveLength(0);
  });

  test("text dedupe is whitespace/case-insensitive but keeps distinct findings", () => {
    const env = consolidate(
      result("claude", [f({ file: "x", line: 1, lens: "correctness", finding: "Off  by ONE" })]),
      result("codex", [
        f({ file: "x", line: 1, lens: "correctness", finding: "off by one" }),
        f({ file: "x", line: 2, lens: "correctness", finding: "different bug" }),
      ]),
      "s",
    );
    expect(env.nits).toHaveLength(2); // the two "off by one" merge; line-2 stays separate
    const merged = env.nits.find((n) => n.line === 1)!;
    expect(merged.raised_by).toEqual(["claude", "codex"]);
  });

  test("preserves a null line", () => {
    const env = consolidate(result("claude", [f({ line: null, severity: "must-fix" })]), result("codex", []), "s");
    expect(env.must_fix[0]!.line).toBeNull();
  });
});
