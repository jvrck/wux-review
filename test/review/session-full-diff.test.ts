import { describe, expect, test } from "bun:test";
import { DEFAULT_LENSES } from "../../src/review/lenses";
import { runReview, type ReviewDeps } from "../../src/review/pipeline";
import { buildReviewerPrompt } from "../../src/review/prompt";
import type { Backend } from "../../src/review/reviewers";
import type { SessionStore } from "../../src/review/session-state";
import type { Finding, SessionState } from "../../src/review/types";

// #94 regression: a `--session` re-review must evaluate the FULL current
// base...head diff, with prior-round findings as context only — so it never
// false-flags content added in an earlier commit (e.g. tests) as "missing". The
// diff has always been the full base...head (getDiff is session-independent —
// see diff.ts), but the pre-#94 re-review prompt wording ("current changed
// lines" / "unchanged code") invited a leg to narrow to the latest fix commit
// and report earlier-commit tests as missing. These tests pin both halves: the
// prompt frame and the end-to-end pipeline behavior.

// A diff that carries a test file added in an EARLIER commit (A) alongside a
// later unrelated fix (B) — the shape of a mid-fix-loop re-review.
const TEST_FILE = "test/foo.test.ts";
const FULL_DIFF =
  `diff --git a/${TEST_FILE} b/${TEST_FILE}\n` +
  "new file mode 100644\n@@ -0,0 +1,2 @@\n+test('covers foo', () => expect(foo()).toBe(1));\n" +
  "diff --git a/app.ts b/app.ts\n@@ -1 +1 @@\n-const foo = () => 0;\n+const foo = () => 1;\n";

describe("#94 re-review prompt frames the diff as the FULL current change", () => {
  const prior: Finding[] = [
    { lens: "correctness", file: "app.ts", line: 1, severity: "must-fix", finding: "off-by-one in loop bound" },
  ];

  test("with prior findings: declares the diff is the full base...head change and forbids calling present content missing", () => {
    const prompt = buildReviewerPrompt(FULL_DIFF, DEFAULT_LENSES, prior);
    // The full diff — including the earlier-commit test file — is present.
    expect(prompt).toContain(FULL_DIFF);
    expect(prompt).toContain(TEST_FILE);
    // The re-review frame makes the full-diff invariant explicit to the model.
    expect(prompt).toContain("FULL current change");
    expect(prompt).toContain("not just the latest commit");
    expect(prompt).toMatch(/Do NOT report anything as missing.*present in that resulting state/s);
    // #97: "present" means the RESULTING state (added/context), NOT removed lines.
    expect(prompt).toContain("resulting state");
    expect(prompt).toContain("lines removed (`-`) are gone");
    // Prior findings are still listed as context (oscillation protection kept).
    expect(prompt).toContain("off-by-one in loop bound");
    expect(prompt).toContain("a finding that was resolved must NOT reappear");
    // The pre-#94 narrowing that caused the false "missing" must-fix is gone.
    expect(prompt).not.toContain("current changed lines");
    expect(prompt).not.toContain("do not introduce new findings on unchanged code");
    // ...but the frame does NOT over-suppress a genuinely-absent-coverage must-fix:
    // code changed with no test in the resulting state — including a DELETED test —
    // is still fair game (#97).
    expect(prompt).toContain("still a valid must-fix");
    expect(prompt).toContain("this diff DELETES");
  });

  test("empty prior findings (a prior approval): same full-diff frame, hold the approval", () => {
    const prompt = buildReviewerPrompt(FULL_DIFF, DEFAULT_LENSES, []);
    expect(prompt).toContain("FULL current change");
    expect(prompt).toMatch(/Do NOT report anything as missing.*present in that resulting state/s);
    expect(prompt).toContain("reported no findings and approved");
    // #97: the coverage carve-out defers to sticky-approve for an approved leg —
    // don't re-open code you already signed off on.
    expect(prompt).toContain("code you already signed off on");
    expect(prompt).not.toContain("current changed lines");
    expect(prompt).not.toContain("unchanged code");
  });

  // The one-shot path is untouched by this change: with no prior findings the
  // re-review frame is absent entirely, and the default call equals the explicit
  // `undefined` call. (The exact pre-#91 one-shot wording is golden-pinned
  // separately in prompt.test.ts; here we only prove the frame does not leak in.)
  test("the one-shot path (no prior findings) carries no re-review frame", () => {
    const oneShot = buildReviewerPrompt(FULL_DIFF, DEFAULT_LENSES);
    expect(oneShot).not.toContain("FULL current change");
    expect(oneShot).not.toContain("context only");
    expect(oneShot).toBe(buildReviewerPrompt(FULL_DIFF, DEFAULT_LENSES, undefined));
  });
});

// An in-memory session store (mirrors pipeline.test.ts) so a two-round re-review
// runs without touching disk.
function memStore(): SessionStore {
  const data = new Map<string, SessionState>();
  return {
    async load(id) {
      return data.get(id);
    },
    async save(id, s) {
      data.set(id, s);
    },
    async clear(id) {
      data.delete(id);
    },
  };
}

const report = (findings: unknown[]): string => "```json\n" + JSON.stringify({ findings }) + "\n```";

// A reviewer leg that models the #94 failure precisely: it raises a false
// "tests missing" must-fix IF AND ONLY IF the test file is absent from the diff
// it is shown. Fed the full base...head diff, it sees the tests and approves; a
// regression that scoped the re-review diff to the latest commit would drop the
// test file from its prompt and it would (for that broken world) block.
function missingIfBlind(): { backend: Backend; prompts: string[] } {
  const prompts: string[] = [];
  const backend: Backend = async (prompt) => {
    prompts.push(prompt);
    const seesTests = prompt.includes(TEST_FILE);
    return report(
      seesTests ? [] : [{ lens: "correctness", file: "app.ts", line: null, severity: "must-fix", finding: "no tests cover app.ts" }],
    );
  };
  return { backend, prompts };
}

function deps(claude: Backend, codex: Backend, store: SessionStore, diff: string, files: string[]): ReviewDeps {
  return {
    loadConfig: async () => ({}),
    getDiff: async () => ({ diff, files }),
    backends: { claude, codex },
    sessionStore: store,
  };
}

describe("#94 pipeline: a --session re-review threads the full base...head diff every round", () => {
  test("round-2 does NOT report earlier-commit tests as missing (they are still in the full diff)", async () => {
    const claude = missingIfBlind();
    const codex = missingIfBlind();
    const d = deps(claude.backend, codex.backend, memStore(), FULL_DIFF, [TEST_FILE, "app.ts"]);

    // Round 1 — tests added in commit A; both legs see them → approve.
    const r1 = await runReview({ session: "s94" }, d);
    expect(r1.verdict).toBe("approve");

    // Round 2 — an unrelated fix (commit B) lands; the FULL diff still carries the
    // commit-A tests, so neither leg false-flags them as missing.
    const r2 = await runReview({ session: "s94" }, d);
    expect(r2.verdict).toBe("approve");
    expect(r2.must_fix).toHaveLength(0);

    // Round 2 is genuinely a re-review: each leg's prompt carries the full-diff
    // frame AND the earlier-commit test file (the mechanism that prevents the
    // false-missing must-fix).
    for (const leg of [claude, codex]) {
      expect(leg.prompts[1]).toContain("FULL current change");
      expect(leg.prompts[1]).toContain(TEST_FILE);
    }
  });

  test("guard is non-vacuous: given a diff that omits the test file, the same leg DOES block", async () => {
    // Prove the leg genuinely reacts to the test file's presence — so the approve
    // above is earned by the full diff, not by a leg that can never block.
    const scopedDiff = "diff --git a/app.ts b/app.ts\n@@ -1 +1 @@\n-const foo = () => 0;\n+const foo = () => 1;\n";
    const claude = missingIfBlind();
    const codex = missingIfBlind();
    const d = deps(claude.backend, codex.backend, memStore(), scopedDiff, ["app.ts"]);

    const r = await runReview({ session: "s94scoped" }, d);
    expect(r.verdict).toBe("block");
    expect(r.must_fix.map((m) => m.finding)).toContain("no tests cover app.ts");
  });
});
