import { describe, expect, test } from "bun:test";
import { findingKey } from "../../src/review/consolidate";
import { applyStickyApprove, nextStickyKeys } from "../../src/review/sticky";
import type { Finding, ReviewResult, Severity } from "../../src/review/types";

const f = (over: Partial<Finding> = {}): Finding => ({
  lens: "correctness",
  file: "x.ts",
  line: 1,
  severity: "nit",
  finding: "thing",
  ...over,
});

const result = (findings: Finding[]): ReviewResult => ({
  reviewer: "claude",
  findings,
  verdict: findings.some((x) => x.severity === "must-fix") ? "block" : "approve",
});

const keys = (...fs: Finding[]) => new Set(fs.map(findingKey));

describe("applyStickyApprove", () => {
  test("empty sticky set (leg never approved) → returned unchanged", () => {
    const current = result([f({ severity: "must-fix" })]);
    expect(applyStickyApprove(current, new Set())).toBe(current);
  });

  test("a current must-fix matching a sticky key is demoted → verdict recomputed to approve", () => {
    const shared = { file: "x.ts", line: 3, lens: "clarity", finding: "rename foo" };
    const sticky = keys(f({ ...shared, severity: "nit" })); // approved-with as a nit earlier
    const current = result([f({ ...shared, severity: "must-fix" })]); // now escalated
    const out = applyStickyApprove(current, sticky);
    expect(out.verdict).toBe("approve");
    expect(out.findings[0]!.severity).toBe("nice-fix");
  });

  test("a must-fix NOT in the sticky set still blocks (no weakening)", () => {
    const sticky = keys(f({ finding: "rename foo", severity: "nit" }));
    const current = result([f({ file: "y.ts", line: 9, lens: "security", severity: "must-fix", finding: "new sqli" })]);
    const out = applyStickyApprove(current, sticky);
    expect(out.verdict).toBe("block");
    expect(out.findings[0]!.severity).toBe("must-fix");
  });

  test("mix: a sticky must-fix is demoted but a new one still blocks", () => {
    const sticky = keys(f({ file: "x.ts", line: 3, lens: "clarity", finding: "rename foo" }));
    const current = result([
      f({ file: "x.ts", line: 3, lens: "clarity", severity: "must-fix", finding: "rename foo" }), // sticky → demoted
      f({ file: "z.ts", line: 1, lens: "correctness", severity: "must-fix", finding: "real regression" }), // new → blocks
    ]);
    const out = applyStickyApprove(current, sticky);
    expect(out.verdict).toBe("block");
    const bySeverity = (s: Severity) => out.findings.filter((x) => x.severity === s).map((x) => x.finding);
    expect(bySeverity("nice-fix")).toEqual(["rename foo"]);
    expect(bySeverity("must-fix")).toEqual(["real regression"]);
  });

  test("match is severity-agnostic and whitespace/case-insensitive (same identity)", () => {
    const sticky = keys(f({ file: "x.ts", line: 3, lens: "clarity", severity: "nice-fix", finding: "Rename  FOO" }));
    const current = result([f({ file: "x.ts", line: 3, lens: "clarity", severity: "must-fix", finding: "rename foo" })]);
    expect(applyStickyApprove(current, sticky).verdict).toBe("approve");
  });

  test("nothing to demote → unchanged reference", () => {
    const current = result([f({ severity: "nice-fix" })]);
    expect(applyStickyApprove(current, keys(f({ severity: "nit" })))).toBe(current);
  });
});

describe("nextStickyKeys", () => {
  test("an approving round adds every finding identity to the set", () => {
    const A = f({ file: "a.ts", line: 1, lens: "clarity", severity: "nit", finding: "A" });
    const B = f({ file: "b.ts", line: 2, lens: "reuse", severity: "nice-fix", finding: "B" });
    const next = nextStickyKeys([], result([A, B]));
    expect(new Set(next)).toEqual(keys(A, B));
  });

  test("a blocking round adds nothing (the leg accepted none of its findings)", () => {
    const prior = [findingKey(f({ finding: "prior" }))];
    const blocked = result([f({ severity: "must-fix", finding: "new bug" })]);
    expect(nextStickyKeys(prior, blocked)).toEqual(prior);
  });

  test("accumulates across rounds and de-dupes", () => {
    const A = f({ file: "a.ts", line: 1, lens: "clarity", severity: "nit", finding: "A" });
    const round1 = nextStickyKeys([], result([A]));
    const round2 = nextStickyKeys(round1, result([A, f({ file: "c.ts", line: 3, lens: "x", severity: "nit", finding: "C" })]));
    expect(round2).toHaveLength(2); // A not duplicated
  });
});
