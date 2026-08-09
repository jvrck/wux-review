import { describe, expect, test } from "bun:test";
import { DEFAULT_LENSES } from "../../src/review/lenses";
import { buildReviewerPrompt, parseReport } from "../../src/review/prompt";
import type { Finding } from "../../src/review/types";

const fenced = (obj: unknown) => "Here is my review.\n\n```json\n" + JSON.stringify(obj) + "\n```\n";

describe("buildReviewerPrompt", () => {
  test("embeds the diff, every lens, and the JSON contract — identically for both reviewers", () => {
    const diff = "diff --git a/x.ts b/x.ts\n+changed\n";
    const prompt = buildReviewerPrompt(diff, DEFAULT_LENSES);
    expect(prompt).toContain(diff);
    for (const lens of DEFAULT_LENSES) {
      expect(prompt).toContain(lens.name);
      expect(prompt).toContain(lens.prompt);
    }
    expect(prompt).toContain('"findings"');
    expect(prompt).toContain("must-fix");
    expect(prompt).toContain("treat the current diff as authoritative");
    expect(prompt).toContain("Do not repeat prior-round findings");
  });

  test("with no priorFindings the prompt is byte-identical to the default (one-shot path unchanged)", () => {
    const diff = "diff --git a/x.ts b/x.ts\n+changed\n";
    // `undefined` (default arg) must equal an explicit `undefined` and carry no
    // re-review block — the pre-#91 prompt.
    expect(buildReviewerPrompt(diff, DEFAULT_LENSES, undefined)).toBe(buildReviewerPrompt(diff, DEFAULT_LENSES));
    expect(buildReviewerPrompt(diff, DEFAULT_LENSES)).not.toContain("In the previous round");
    // Golden pin of the exact insertion region, so an edit that alters BOTH the
    // default and re-review paths identically (which the === check above would
    // miss) still fails the hard "byte-identical to the pre-#91 default prompt"
    // requirement: no stray re-review text, and the blank-line spacing is exact.
    expect(buildReviewerPrompt(diff, DEFAULT_LENSES)).toContain(
      "Do not repeat prior-round findings unless the issue is still visible in the current diff.\n\nApply every one of these lenses:",
    );
  });

  test("with concrete priorFindings, the re-review section lists them and forbids re-raising resolved items", () => {
    const prior: Finding[] = [
      { lens: "correctness", file: "app.ts", line: 10, severity: "must-fix", finding: "unbounded loop" },
      { lens: "clarity", file: "y.ts", line: null, severity: "nit", finding: "rename foo" },
    ];
    const prompt = buildReviewerPrompt("diff", DEFAULT_LENSES, prior);
    expect(prompt).toContain("In the previous round you reported these findings");
    expect(prompt).toContain("[must-fix] app.ts:10 (correctness) — unbounded loop");
    expect(prompt).toContain("[nit] y.ts (clarity) — rename foo"); // null line → file only
    expect(prompt).toContain("a finding that was resolved must NOT reappear");
  });

  test("empty priorFindings signals a prior approval (hold it absent a new changed-line defect)", () => {
    const prompt = buildReviewerPrompt("diff", DEFAULT_LENSES, []);
    expect(prompt).toContain("you reported no findings and approved");
    expect(prompt).not.toContain("In the previous round you reported these findings");
  });

  test("instructs a runnable repro for every must-fix and includes repro in the JSON contract (#101)", () => {
    const prompt = buildReviewerPrompt("diff", DEFAULT_LENSES);
    expect(prompt).toContain("Every must-fix");
    expect(prompt).toContain("MUST carry a \"repro\"");
    expect(prompt).toContain('"repro": "<runnable command; required for must-fix, omit otherwise>"');
  });

  test("shows the leg its refutation ledger when reviewer + ledger are supplied (#101)", () => {
    const ledger = [{ key: "k", finding: "regex $ wrong", evidence: "node -e prints false; CI green", round: 1, refutedRepros: [] }];
    const prompt = buildReviewerPrompt("diff", DEFAULT_LENSES, undefined, "codex", ledger);
    expect(prompt).toContain("REFUTED (round 1)");
    expect(prompt).toContain("regex $ wrong");
    expect(prompt).toContain("node -e prints false; CI green");
    expect(prompt).toContain("demoted to advisory");
  });

  test("an empty ledger leaves the prompt unchanged (byte-identical to no ledger)", () => {
    expect(buildReviewerPrompt("diff", DEFAULT_LENSES, undefined, "codex", [])).toBe(buildReviewerPrompt("diff", DEFAULT_LENSES));
  });
});

describe("parseReport", () => {
  test("parses a fenced JSON findings block and computes block on any must-fix", () => {
    const raw = fenced({
      findings: [
        { lens: "correctness", file: "x.ts", line: 12, severity: "must-fix", finding: "off by one" },
        { lens: "clarity", file: "y.ts", line: null, severity: "nit", finding: "rename" },
      ],
    });
    const result = parseReport("claude", raw);
    expect(result.reviewer).toBe("claude");
    expect(result.verdict).toBe("block");
    expect(result.findings).toHaveLength(2);
    expect(result.findings[0]!.line).toBe(12);
    expect(result.findings[1]!.line).toBeNull();
  });

  test("no must-fix yields approve; empty findings yields approve", () => {
    expect(
      parseReport("codex", fenced({ findings: [{ lens: "clarity", file: "a", line: 1, severity: "nice-fix", finding: "x" }] }))
        .verdict,
    ).toBe("approve");
    expect(parseReport("codex", fenced({ findings: [] })).verdict).toBe("approve");
  });

  test("accepts a bare JSON object with no fence", () => {
    expect(parseReport("codex", JSON.stringify({ findings: [] })).verdict).toBe("approve");
  });

  test("uses the last fenced block when several are present (ignores the contract example)", () => {
    const raw =
      "```json\n" +
      JSON.stringify({ findings: [{ lens: "x", file: "f", line: 1, severity: "must-fix", finding: "example" }] }) +
      "\n```\n...then my real review...\n" +
      fenced({ findings: [] });
    expect(parseReport("claude", raw).verdict).toBe("approve");
  });

  test("parses an optional repro on a finding (#101), and it is absent when omitted", () => {
    const raw =
      "```json\n" +
      JSON.stringify({
        findings: [
          { lens: "security", file: "a.ts", line: 1, severity: "must-fix", finding: "bug", repro: "node -e 'x'" },
          { lens: "clarity", file: "b.ts", line: 2, severity: "nit", finding: "style" },
        ],
      }) +
      "\n```";
    const result = parseReport("codex", raw);
    expect(result.findings[0]!.repro).toBe("node -e 'x'");
    expect(result.findings[1]!.repro).toBeUndefined();
  });

  test("missing line defaults to null", () => {
    const result = parseReport("claude", fenced({ findings: [{ lens: "correctness", file: "x", severity: "nit", finding: "z" }] }));
    expect(result.findings[0]!.line).toBeNull();
  });

  test("parses a fence-heavy answer: a finding string quotes a ```py block, whole answer wrapped in ```json", () => {
    // The real object is wrapped in ```json AND one finding value embeds a ```py
    // code fence lifted from the diff. The old non-greedy fence regex closed at
    // the first inner ``` and returned a fragment → JSON.parse threw. The
    // string-aware scan ignores backticks/braces inside string values.
    const findings = [
      {
        lens: "correctness",
        file: "run.py",
        line: 7,
        severity: "must-fix",
        finding: "This hunk drops the guard:\n```py\nif not ok: { return }\n```\nrestore it.",
      },
    ];
    const raw = "Here is my review.\n\n```json\n" + JSON.stringify({ findings }) + "\n```\n";
    const result = parseReport("codex", raw);
    expect(result.verdict).toBe("block");
    expect(result.findings).toHaveLength(1);
    expect(result.findings[0]!.finding).toContain("```py");
    expect(result.findings[0]!.file).toBe("run.py");
  });

  test("parses when multiple interior ``` fences and braces appear across several finding strings", () => {
    const findings = [
      { lens: "correctness", file: "a.ts", line: 1, severity: "nit", finding: "see ```ts\nconst x = {};\n``` above" },
      { lens: "clarity", file: "b.py", line: null, severity: "nice-fix", finding: "and ```py\nd = {'k': 1}\n``` here" },
      { lens: "security", file: "c.sh", line: 3, severity: "must-fix", finding: "unquoted ```bash\nrm -rf ${DIR}\n```" },
    ];
    const raw = "```json\n" + JSON.stringify({ findings }) + "\n```";
    const result = parseReport("codex", raw);
    expect(result.verdict).toBe("block");
    expect(result.findings).toHaveLength(3);
    expect(result.findings[1]!.line).toBeNull();
    expect(result.findings[2]!.finding).toContain("${DIR}");
  });

  test("lands the last real object when a fenced contract-example precedes a fence-heavy answer", () => {
    const example = { findings: [{ lens: "x", file: "f", line: 1, severity: "must-fix", finding: "example" }] };
    const real = {
      findings: [{ lens: "clarity", file: "y.ts", line: null, severity: "nice-fix", finding: "wrap ```ts\n{a}\n``` cleanly" }],
    };
    const raw = "```json\n" + JSON.stringify(example) + "\n```\n...my real review...\n```json\n" + JSON.stringify(real) + "\n```";
    const result = parseReport("codex", raw);
    expect(result.verdict).toBe("approve");
    expect(result.findings).toHaveLength(1);
    expect(result.findings[0]!.finding).toContain("```ts");
  });

  test("unparseable output is a hard error (no JSON / invalid JSON / wrong shape)", () => {
    expect(() => parseReport("claude", "I approve, looks good.")).toThrow("no JSON findings block");
    expect(() => parseReport("claude", "```json\n{not json}\n```")).toThrow("invalid JSON");
    expect(() =>
      parseReport("claude", fenced({ findings: [{ lens: "x", file: "f", line: 1, severity: "blocker", finding: "z" }] })),
    ).toThrow("invalid findings object");
  });
});
