import { describe, expect, test } from "bun:test";
import { findingKey } from "../../src/review/consolidate";
import {
  applyRefutationLedger,
  mergeLedger,
  parseRefutations,
  refutationKey,
  refutationLedgerSection,
} from "../../src/review/refutation";
import type { Finding, Refutation, RefutationEntry, ReviewResult } from "../../src/review/types";

// The #213-shaped wrong blocker: a [security] must-fix asserting JS `$` matches
// before a trailing newline (false in JS without /m), raised with no repro.
const wrongBlocker: Finding = { lens: "security", file: "src/x.ts", line: 42, severity: "must-fix", finding: "regex $ matches before a trailing newline" };
const key = findingKey(wrongBlocker);
const blockResult = (findings: Finding[]): ReviewResult => ({ reviewer: "codex", findings, verdict: "block" });
// A ledger entry for `wrongBlocker`, refuted while unproven (no prior repro).
const entryFor = (over: Partial<RefutationEntry> = {}): RefutationEntry => ({ key, finding: wrongBlocker.finding, evidence: "node -e prints false", round: 1, refutedRepros: [], ...over });
// By default the finding was raised in the prior round (a genuine re-raise).
const raisedBefore = new Set([key]);

describe("applyRefutationLedger", () => {
  test("demotes a refuted, unproven (no-repro) re-raised must-fix to advisory + tags it, and unblocks", () => {
    const out = applyRefutationLedger(blockResult([wrongBlocker]), [entryFor()], raisedBefore);
    expect(out.findings[0]!.severity).toBe("nice-fix");
    expect(out.findings[0]!.persistentUnproven).toBe(true);
    expect(out.verdict).toBe("approve"); // the only blocker was demoted → unblocks
  });

  test("does NOT demote a re-raise carrying a NEW repro (proven, immune while its repro stands)", () => {
    const proven: Finding = { ...wrongBlocker, repro: "node -e 'process.exit(/x$/.test(\"x\\n\") ? 1 : 0)'" };
    const out = applyRefutationLedger(blockResult([proven]), [entryFor()], raisedBefore);
    expect(out.findings[0]!.severity).toBe("must-fix"); // proven blocker stands
    expect(out.verdict).toBe("block");
  });

  test("DOES demote a re-raise carrying the SAME already-refuted repro (that repro is not new proof)", () => {
    const refuted = "node -e 'wrong'";
    const proven: Finding = { ...wrongBlocker, repro: refuted };
    const out = applyRefutationLedger(blockResult([proven]), [entryFor({ refutedRepros: [refuted] })], raisedBefore);
    expect(out.findings[0]!.severity).toBe("nice-fix"); // same repro was already refuted
    expect(out.verdict).toBe("approve");
  });

  test("a re-raise carrying a repro that cycles back to an EARLIER refuted one is still demoted", () => {
    const proven: Finding = { ...wrongBlocker, repro: "node -e 'r1'" };
    const out = applyRefutationLedger(blockResult([proven]), [entryFor({ refutedRepros: ["node -e 'r1'", "node -e 'r2'"] })], raisedBefore);
    expect(out.findings[0]!.severity).toBe("nice-fix"); // r1 was already refuted, even though r2 came later
  });

  test("accepts a FIRST-appearance finding even if a stale refutation names it (not raised in the prior round)", () => {
    const out = applyRefutationLedger(blockResult([wrongBlocker]), [entryFor()], new Set()); // not in prior findings
    expect(out.findings[0]!.severity).toBe("must-fix"); // accepted in its first round
    expect(out.verdict).toBe("block");
  });

  test("does not demote a must-fix that is NOT in the ledger (a genuinely new blocker still blocks)", () => {
    const fresh: Finding = { lens: "correctness", file: "src/y.ts", line: 1, severity: "must-fix", finding: "off-by-one" };
    const out = applyRefutationLedger(blockResult([fresh]), [entryFor()], new Set([key, findingKey(fresh)]));
    expect(out.findings[0]!.severity).toBe("must-fix");
    expect(out.verdict).toBe("block");
  });

  test("only the refuted-unproven finding is demoted; a co-occurring genuine must-fix keeps the block", () => {
    const fresh: Finding = { lens: "correctness", file: "src/y.ts", line: 1, severity: "must-fix", finding: "off-by-one" };
    const out = applyRefutationLedger(blockResult([wrongBlocker, fresh]), [entryFor()], new Set([key, findingKey(fresh)]));
    expect(out.findings.find((f) => f.finding === wrongBlocker.finding)!.severity).toBe("nice-fix");
    expect(out.findings.find((f) => f.finding === "off-by-one")!.severity).toBe("must-fix");
    expect(out.verdict).toBe("block"); // never auto-approves — the genuine blocker stands
  });

  test("an empty ledger leaves the result untouched (identity)", () => {
    const r = blockResult([wrongBlocker]);
    expect(applyRefutationLedger(r, [], raisedBefore)).toBe(r);
  });

  test("does not touch nice-fix / nit findings whose key happens to be refuted", () => {
    const advisory: Finding = { ...wrongBlocker, severity: "nice-fix" };
    const out = applyRefutationLedger({ reviewer: "codex", findings: [advisory], verdict: "approve" }, [entryFor()], raisedBefore);
    expect(out.findings[0]!.severity).toBe("nice-fix");
    expect(out.findings[0]!.persistentUnproven).toBeUndefined();
  });
});

describe("mergeLedger", () => {
  const refutation: Refutation = { reviewer: "codex", file: "src/x.ts", line: 42, lens: "security", finding: wrongBlocker.finding, evidence: "node -e prints false; CI green" };
  const noPrior = { claude: [] as Finding[], codex: [] as Finding[] };

  test("adds a keyed entry to the right leg, stamped with the round; no refuted repros when unproven", () => {
    const merged = mergeLedger({ claude: [], codex: [] }, [refutation], 2, noPrior);
    expect(merged.claude).toEqual([]);
    expect(merged.codex).toHaveLength(1);
    expect(merged.codex[0]).toEqual({ key: refutationKey(refutation), finding: wrongBlocker.finding, evidence: "node -e prints false; CI green", round: 2, refutedRepros: [] });
    expect(refutationKey(refutation)).toBe(key); // matches the finding it refutes
  });

  test("captures the refuted finding's repro from the prior round (so a re-raise needs a NEW one)", () => {
    const priorProven = { claude: [] as Finding[], codex: [{ ...wrongBlocker, repro: "node -e 'wrong'" }] };
    const merged = mergeLedger({ claude: [], codex: [] }, [refutation], 2, priorProven);
    expect(merged.codex[0]!.refutedRepros).toEqual(["node -e 'wrong'"]);
  });

  test("ACCUMULATES refuted repros across refutations and never erases one on an absent round", () => {
    const withR1 = { claude: [] as Finding[], codex: [{ ...wrongBlocker, repro: "node -e 'r1'" }] };
    const withR2 = { claude: [] as Finding[], codex: [{ ...wrongBlocker, repro: "node -e 'r2'" }] };
    let ledger = mergeLedger({ claude: [], codex: [] }, [refutation], 1, withR1); // refute r1
    ledger = mergeLedger(ledger, [refutation], 2, withR2); // leg re-proved with r2; refute r2 too
    ledger = mergeLedger(ledger, [refutation], 3, noPrior); // finding absent this round → must NOT erase
    expect(ledger.codex[0]!.refutedRepros.sort()).toEqual(["node -e 'r1'", "node -e 'r2'"]);
  });

  test("dedupes by key per leg (a repeated refutation refreshes evidence/round, no duplicate)", () => {
    const prior = mergeLedger({ claude: [], codex: [] }, [refutation], 1, noPrior);
    const merged = mergeLedger(prior, [{ ...refutation, evidence: "updated evidence" }], 3, noPrior);
    expect(merged.codex).toHaveLength(1);
    expect(merged.codex[0]!.evidence).toBe("updated evidence");
    expect(merged.codex[0]!.round).toBe(3);
  });

  test("does not mutate the prior ledger", () => {
    const prior = { claude: [] as RefutationEntry[], codex: [] as RefutationEntry[] };
    mergeLedger(prior, [refutation], 1, noPrior);
    expect(prior.codex).toHaveLength(0);
  });
});

describe("parseRefutations", () => {
  test("parses a valid refutations file", () => {
    const raw = JSON.stringify([{ reviewer: "codex", file: "a.ts", line: 3, lens: "security", finding: "bad", evidence: "node -e ok" }]);
    const out = parseRefutations(raw);
    expect(out).toHaveLength(1);
    expect(out[0]!.reviewer).toBe("codex");
  });

  test("defaults a missing line to null", () => {
    const raw = JSON.stringify([{ reviewer: "claude", file: "a.ts", lens: "clarity", finding: "x", evidence: "y" }]);
    expect(parseRefutations(raw)[0]!.line).toBeNull();
  });

  test("malformed JSON is a typed error", () => {
    expect(() => parseRefutations("{not json")).toThrow("could not parse JSON");
  });

  test("a wrong-shape entry (missing evidence / bad reviewer) is a typed error", () => {
    expect(() => parseRefutations(JSON.stringify([{ reviewer: "codex", file: "a.ts", lens: "s", finding: "x" }]))).toThrow("invalid refutations file");
    expect(() => parseRefutations(JSON.stringify([{ reviewer: "nobody", file: "a.ts", lens: "s", finding: "x", evidence: "y" }]))).toThrow("invalid refutations file");
  });
});

describe("refutationLedgerSection", () => {
  test("empty ledger yields no section", () => {
    expect(refutationLedgerSection("codex", [])).toBe("");
  });

  test("lists each refuted finding + evidence and warns against re-raising without new proof", () => {
    const entries: RefutationEntry[] = [{ key, finding: wrongBlocker.finding, evidence: "node -e prints false", round: 1, refutedRepros: [] }];
    const section = refutationLedgerSection("codex", entries);
    expect(section).toContain("REFUTED (round 1)");
    expect(section).toContain(wrongBlocker.finding);
    expect(section).toContain("node -e prints false");
    expect(section).toContain("persistent-unproven");
    expect(section).toContain("NEW runnable repro");
  });
});
