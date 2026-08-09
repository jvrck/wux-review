import { describe, expect, test } from "bun:test";
import { consolidate, type VerdictEnvelope } from "../../src/review/consolidate";
import { exitCodeFor, renderHuman, renderJson } from "../../src/review/render";

const blockEnv: VerdictEnvelope = {
  verdict: "block",
  must_fix: [{ lens: "security", file: "x.ts", line: 42, finding: "validate token", raised_by: ["codex"] }],
  nice_fix: [{ lens: "clarity", file: "y.ts", line: null, finding: "rename", raised_by: ["claude", "codex"] }],
  nits: [],
  reviewers: { claude: "approve", codex: "block" },
  session: "abc123",
};

const approveEnv: VerdictEnvelope = {
  verdict: "approve",
  must_fix: [],
  nice_fix: [],
  nits: [],
  reviewers: { claude: "approve", codex: "approve" },
  session: "z9",
};

describe("exitCodeFor", () => {
  test("approve -> 0, block -> 2", () => {
    expect(exitCodeFor(approveEnv)).toBe(0);
    expect(exitCodeFor(blockEnv)).toBe(2);
  });
});

describe("renderJson", () => {
  test("emits the exact spec envelope shape and round-trips", () => {
    const parsed = JSON.parse(renderJson(blockEnv));
    expect(parsed).toEqual(blockEnv);
    expect(Object.keys(parsed)).toEqual(["verdict", "must_fix", "nice_fix", "nits", "reviewers", "session"]);
  });

  test("omits the out-of-band `round` field (#100) — the --json envelope shape is unchanged", () => {
    const env: VerdictEnvelope = { ...blockEnv, round: 7 };
    const json = renderJson(env);
    expect(json).not.toContain("round"); // the presentation aid never leaks into --json
    const parsed = JSON.parse(json);
    expect(parsed.round).toBeUndefined();
    expect(Object.keys(parsed)).toEqual(["verdict", "must_fix", "nice_fix", "nits", "reviewers", "session"]);
  });

  test("omits the out-of-band persistentUnproven tag from --json (#101)", () => {
    const env: VerdictEnvelope = {
      ...approveEnv,
      nice_fix: [{ lens: "security", file: "x.ts", line: 1, finding: "wrong claim", raised_by: ["codex"], persistentUnproven: { codex: true } }],
    };
    const json = renderJson(env);
    expect(json).not.toContain("persistentUnproven");
    expect(JSON.parse(json).nice_fix[0].persistentUnproven).toBeUndefined();
    expect(Object.keys(JSON.parse(json).nice_fix[0])).toEqual(["lens", "file", "line", "finding", "raised_by"]);
  });

  test("omits the in-memory perReviewer field — consolidated --json keeps the max bucketing", () => {
    const shared = { lens: "security", file: "x.ts", line: 7, finding: "Validate the token" };
    const env = consolidate(
      { reviewer: "claude", verdict: "approve", findings: [{ ...shared, severity: "nice-fix" }] },
      { reviewer: "codex", verdict: "block", findings: [{ ...shared, severity: "must-fix" }] },
      "s",
    );
    expect(env.must_fix[0]!.perReviewer).toBeDefined(); // present in memory for per-agent comments
    const json = renderJson(env);
    expect(json).not.toContain("perReviewer"); // …but never serialized into --json
    const parsed = JSON.parse(json);
    expect(parsed.verdict).toBe("block");
    expect(parsed.must_fix).toHaveLength(1); // still bucketed by the consolidated max
    expect(Object.keys(parsed.must_fix[0])).toEqual(["lens", "file", "line", "finding", "raised_by"]);
  });
});

describe("renderHuman", () => {
  test("renders the verdict, reviewers, session, and findings with raised_by", () => {
    const out = renderHuman(blockEnv);
    expect(out).toContain("BLOCK");
    expect(out).toContain("claude approve · codex block");
    expect(out).toContain("session: abc123");
    expect(out).toContain("MUST-FIX (1)");
    expect(out).toContain("[security] x.ts:42 — validate token (raised by codex)");
    expect(out).toContain("[clarity] y.ts — rename (raised by claude, codex)"); // null line -> file only
  });

  test("surfaces a finding's runnable repro in the human view but keeps it off --json (#101)", () => {
    const env: VerdictEnvelope = {
      ...blockEnv,
      must_fix: [{ lens: "security", file: "x.ts", line: 42, finding: "sql injection", raised_by: ["codex"], repro: { codex: "node -e 'inject()'" } }],
    };
    const human = renderHuman(env);
    expect(human).toContain("repro: node -e 'inject()'");
    const json = renderJson(env);
    expect(json).not.toContain("node -e 'inject()'"); // proof shown to humans, off the machine envelope
    expect(json).not.toContain("repro");
  });

  test("tags a demoted persistent-unproven finding in the human view (#101)", () => {
    const env: VerdictEnvelope = {
      ...approveEnv,
      nice_fix: [{ lens: "security", file: "x.ts", line: 1, finding: "wrong claim", raised_by: ["codex"], persistentUnproven: { codex: true } }],
    };
    const out = renderHuman(env);
    expect(out).toContain("wrong claim");
    expect(out).toContain("`persistent-unproven`");
  });

  test("an approve with no findings says so", () => {
    const out = renderHuman(approveEnv);
    expect(out).toContain("APPROVE");
    expect(out).toContain("No findings.");
  });
});
