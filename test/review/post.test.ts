import { describe, expect, test } from "bun:test";
import { consolidate, type VerdictEnvelope } from "../../src/review/consolidate";
import { postToPr, renderAgentComment } from "../../src/review/post";
import type { Run, RunResult } from "../../src/runtime/exec";

const ok = (stdout = ""): RunResult => ({ code: 0, stdout, stderr: "" });

// A fixed "updated" timestamp so header rendering is deterministic in tests.
const AT = "2026-07-24T12:00:00Z";

const ENV: VerdictEnvelope = {
  verdict: "block",
  must_fix: [{ lens: "security", file: "x.ts", line: 42, finding: "validate token", raised_by: ["codex"] }],
  nice_fix: [{ lens: "clarity", file: "y.ts", line: null, finding: "rename", raised_by: ["claude", "codex"] }],
  nits: [],
  reviewers: { claude: "approve", codex: "block" },
  session: "abc123",
};

// Route gh commands: repo resolution, the per-marker existing-comment lookup, and
// the PATCH/POST writes. `existing` gives the prior comment id per reviewer (the
// lookup picks by the marker embedded in the jq filter).
function harness(existing: { claude?: string; codex?: string; legacy?: string } = {}) {
  const calls: string[][] = [];
  const run: Run = async (cmd) => {
    calls.push(cmd);
    const joined = cmd.join(" ");
    if (joined.includes("gh repo view")) return ok("jvrck/wux-review\n");
    if (joined.includes("gh api user")) return ok("jvrck\n");
    if (joined.includes("--paginate")) {
      const id = joined.includes("dual-review:claude")
        ? existing.claude
        : joined.includes("dual-review:codex")
          ? existing.codex
          : joined.includes("wux-review -->")
            ? existing.legacy
            : undefined;
      return ok(id ? `${id}\n` : "");
    }
    return ok("");
  };
  return { run, calls };
}

const findAll = (calls: string[][], token: string) => calls.filter((c) => c.includes(token));
const bodyArg = (cmd: string[]) => cmd.find((a) => a.startsWith("body="))!;

describe("postToPr", () => {
  test("posts exactly one comment per reviewer, each with its own marker, when none exist", async () => {
    const { run, calls } = harness({});
    await postToPr(42, ENV, run);

    const posts = findAll(calls, "POST");
    expect(posts).toHaveLength(2);
    expect(findAll(calls, "PATCH")).toHaveLength(0);
    const bodies = posts.map((p) => bodyArg(p));
    const claudeBody = bodies.find((b) => b.includes("<!-- dual-review:claude -->"))!;
    const codexBody = bodies.find((b) => b.includes("<!-- dual-review:codex -->"))!;
    expect(claudeBody).toBeDefined();
    expect(codexBody).toBeDefined();
    // Each comment carries its OWN reviewer's verdict (claude approves, codex blocks).
    expect(claudeBody).toContain("claude: 🟢 approve");
    expect(codexBody).toContain("codex: 🔴 block");
  });

  test("updates each reviewer's comment in place (PATCH) when both already exist", async () => {
    const { run, calls } = harness({ claude: "111", codex: "222" });
    await postToPr(42, ENV, run);
    const patches = findAll(calls, "PATCH");
    expect(patches).toHaveLength(2);
    expect(patches.some((p) => p.join(" ").includes("repos/jvrck/wux-review/issues/comments/111"))).toBe(true);
    expect(patches.some((p) => p.join(" ").includes("repos/jvrck/wux-review/issues/comments/222"))).toBe(true);
    expect(findAll(calls, "POST")).toHaveLength(0);
  });

  test("mixes per reviewer: update the one that exists, create the one that doesn't", async () => {
    const { run, calls } = harness({ claude: "111" });
    await postToPr(42, ENV, run);
    const patches = findAll(calls, "PATCH");
    expect(patches).toHaveLength(1);
    expect(patches[0]!.join(" ")).toContain("comments/111");
    const posts = findAll(calls, "POST");
    expect(posts).toHaveLength(1);
    expect(bodyArg(posts[0]!)).toContain("<!-- dual-review:codex -->");
  });

  test("updates the most recent matching comment when a reviewer has several", async () => {
    const { run, calls } = harness({ claude: "123\n999", codex: "55" });
    await postToPr(42, ENV, run);
    const patches = findAll(calls, "PATCH");
    expect(patches.some((p) => p.join(" ").includes("comments/999"))).toBe(true); // last claude id
    expect(patches.some((p) => p.join(" ").includes("comments/55"))).toBe(true);
  });

  test("scopes each lookup to our own comments (author check), without --slurp", async () => {
    const { run, calls } = harness({});
    await postToPr(42, ENV, run);
    // three lookups: the legacy sweep + one per reviewer.
    const lookups = findAll(calls, "--paginate");
    expect(lookups).toHaveLength(3);
    for (const lookup of lookups) {
      expect(lookup.join(" ")).toContain(".user.login");
      expect(lookup).not.toContain("--slurp");
    }
  });

  test("sweeps a legacy consolidated comment (DELETE) before posting the per-agent comments", async () => {
    const { run, calls } = harness({ legacy: "777" });
    await postToPr(42, ENV, run);
    const deletes = findAll(calls, "DELETE");
    expect(deletes).toHaveLength(1);
    expect(deletes[0]!.join(" ")).toContain("repos/jvrck/wux-review/issues/comments/777");
    // and still posts exactly the two per-agent comments
    expect(findAll(calls, "POST")).toHaveLength(2);
  });

  test("deletes nothing when there is no legacy comment", async () => {
    const { run, calls } = harness({});
    await postToPr(42, ENV, run);
    expect(findAll(calls, "DELETE")).toHaveLength(0);
  });

  test("errors cleanly when the repo cannot be resolved", async () => {
    const run: Run = async (cmd) => (cmd.join(" ").includes("gh repo view") ? ok("\n") : ok(""));
    await expect(postToPr(42, ENV, run)).rejects.toThrow("could not resolve the repository");
  });

  test("returns each leg's comment URL + round, requests .html_url, and stamps the header (#100)", async () => {
    const calls: string[][] = [];
    const run: Run = async (cmd) => {
      calls.push(cmd);
      const joined = cmd.join(" ");
      if (joined.includes("gh repo view")) return ok("jvrck/wux-review\n");
      if (joined.includes("gh api user")) return ok("jvrck\n");
      if (joined.includes("--paginate")) return ok(""); // none exist → POST
      if (cmd.includes("POST")) {
        const url = bodyArg(cmd).includes("dual-review:claude") ? "https://gh/c/claude" : "https://gh/c/codex";
        return ok(`${url}\n`);
      }
      return ok("");
    };
    const env: VerdictEnvelope = { ...ENV, round: 3 };
    const results = await postToPr(42, env, run, () => AT);

    expect(results).toEqual([
      { reviewer: "claude", url: "https://gh/c/claude", round: 3 },
      { reviewer: "codex", url: "https://gh/c/codex", round: 3 },
    ]);
    // Each write asks gh for the resulting comment's html_url.
    for (const write of calls.filter((c) => c.includes("POST"))) {
      expect(write).toContain("--jq");
      expect(write).toContain(".html_url");
    }
    // The visible header carries round + updated-at + THAT leg's verdict.
    const bodies = calls.filter((c) => c.includes("POST")).map(bodyArg);
    const claudeBody = bodies.find((b) => b.includes("dual-review:claude"))!;
    expect(claudeBody).toContain("**Dual-review (claude) — round 3 · updated 2026-07-24T12:00:00Z · verdict: clean**");
    const codexBody = bodies.find((b) => b.includes("dual-review:codex"))!;
    expect(codexBody).toContain("**Dual-review (codex) — round 3 · updated 2026-07-24T12:00:00Z · verdict: must-fix**");
  });

  test("a multi-round re-review keeps the comment count at 2 (upsert preserved) while the header changes", async () => {
    // Both comments already exist → two PATCHes, zero POSTs: the count stays 2.
    const { run, calls } = harness({ claude: "111", codex: "222" });
    const results = await postToPr(42, { ...ENV, round: 4 }, run, () => AT);
    expect(findAll(calls, "PATCH")).toHaveLength(2);
    expect(findAll(calls, "POST")).toHaveLength(0);
    // The header (round + updated) is what changed in place, not the count.
    const patched = findAll(calls, "PATCH").map(bodyArg);
    expect(patched.every((b) => b.includes("round 4 · updated 2026-07-24T12:00:00Z"))).toBe(true);
    expect(results.every((r) => r.round === 4)).toBe(true);
  });
});

describe("renderAgentComment", () => {
  test("renders only the reviewer's own findings and its own verdict", () => {
    const claude = renderAgentComment(ENV, "claude", AT);
    expect(claude).toContain("wux-review · claude: 🟢 approve");
    expect(claude).toContain("### Nice-fix (1)");
    expect(claude).toContain("rename");
    expect(claude).not.toContain("validate token"); // codex-only must-fix is absent from claude's comment
    expect(claude).not.toContain("Must-fix");
    expect(claude).toContain("session `abc123`");

    const codex = renderAgentComment(ENV, "codex", AT);
    expect(codex).toContain("wux-review · codex: 🔴 block");
    expect(codex).toContain("### Must-fix (1)");
    expect(codex).toContain("**[security]** `x.ts:42` — validate token _(raised by codex)_");
    expect(codex).toContain("### Nice-fix (1)"); // the shared finding appears for codex too
  });

  test("a reviewer with no findings says so", () => {
    const env: VerdictEnvelope = { ...ENV, must_fix: [], nice_fix: [], nits: [] };
    const claude = renderAgentComment(env, "claude", AT);
    expect(claude).toContain("🟢 approve");
    expect(claude).toContain("No findings.");
  });

  test("the header line carries round, updated timestamp, and THIS leg's verdict (#100)", () => {
    const env: VerdictEnvelope = { ...ENV, round: 4 }; // claude approves, codex blocks
    expect(renderAgentComment(env, "claude", AT)).toContain(
      "**Dual-review (claude) — round 4 · updated 2026-07-24T12:00:00Z · verdict: clean**",
    );
    expect(renderAgentComment(env, "codex", AT)).toContain(
      "**Dual-review (codex) — round 4 · updated 2026-07-24T12:00:00Z · verdict: must-fix**",
    );
  });

  test("round defaults to 1 when the envelope carries no round (one-shot --post-to-pr)", () => {
    expect(renderAgentComment(ENV, "claude", AT)).toContain("round 1 · updated 2026-07-24T12:00:00Z");
  });

  test("shows a must-fix finding's repro inline in the raising leg's comment (#101)", () => {
    const env: VerdictEnvelope = {
      ...ENV,
      must_fix: [{ lens: "security", file: "x.ts", line: 42, finding: "sql injection", raised_by: ["codex"], perReviewer: { codex: "must-fix" }, repro: { codex: "node -e 'inject()'" } }],
      reviewers: { claude: "approve", codex: "block" },
    };
    const codex = renderAgentComment(env, "codex", AT);
    expect(codex).toContain("repro: `node -e 'inject()'`");
    // claude did not raise it and has no repro for it → its comment shows no repro line
    expect(renderAgentComment(env, "claude", AT)).not.toContain("repro:");
  });

  test("wraps a repro containing backticks in a widened code fence (backtick-safe) (#101)", () => {
    const env: VerdictEnvelope = {
      ...ENV,
      must_fix: [{ lens: "security", file: "x.ts", line: 1, finding: "cmd injection", raised_by: ["codex"], perReviewer: { codex: "must-fix" }, repro: { codex: "sh -c '`whoami`'" } }],
      reviewers: { claude: "approve", codex: "block" },
    };
    const codex = renderAgentComment(env, "codex", AT);
    // A plain single-backtick span would break on the embedded `; the fence widens
    // to `` and the full command is preserved intact.
    expect(codex).toContain("repro: ``sh -c '`whoami`'``");
  });

  test("tags a demoted finding `persistent-unproven` in the raising leg's comment (#101 AC4)", () => {
    const env: VerdictEnvelope = {
      verdict: "approve",
      must_fix: [],
      nice_fix: [
        {
          lens: "security",
          file: "x.ts",
          line: 42,
          finding: "regex $ matches before a trailing newline",
          raised_by: ["codex"],
          perReviewer: { codex: "nice-fix" },
          persistentUnproven: { codex: true },
        },
      ],
      nits: [],
      reviewers: { claude: "approve", codex: "approve" },
      session: "s101",
    };
    const codex = renderAgentComment(env, "codex", AT);
    expect(codex).toContain("regex $ matches before a trailing newline");
    expect(codex).toContain("`persistent-unproven`"); // demoted, still visible, flagged
    // claude did not raise it → it is absent from claude's comment (never tagged there)
    expect(renderAgentComment(env, "claude", AT)).not.toContain("persistent-unproven");
  });

  test("buckets each agent's comment by THAT agent's own severity, not the consolidated max", () => {
    // The SAME finding: claude rates it nice-fix, codex rates it must-fix.
    const shared = { lens: "security", file: "x.ts", line: 7, finding: "Validate the token" };
    const env = consolidate(
      { reviewer: "claude", verdict: "approve", findings: [{ ...shared, severity: "nice-fix" }] },
      { reviewer: "codex", verdict: "block", findings: [{ ...shared, severity: "must-fix" }] },
      "sess-mix",
    );

    const claude = renderAgentComment(env, "claude", AT);
    expect(claude).toContain("wux-review · claude: 🟢 approve");
    expect(claude).toContain("### Nice-fix (1)"); // claude sees its OWN nice-fix…
    expect(claude).not.toContain("Must-fix"); // …never the escalated max
    // cross-agreement stays visible in claude's comment
    expect(claude).toContain("**[security]** `x.ts:7` — Validate the token _(raised by claude, codex)_");

    const codex = renderAgentComment(env, "codex", AT);
    expect(codex).toContain("wux-review · codex: 🔴 block");
    expect(codex).toContain("### Must-fix (1)"); // codex sees its OWN must-fix
    expect(codex).not.toContain("Nice-fix");
    expect(codex).toContain("**[security]** `x.ts:7` — Validate the token _(raised by claude, codex)_");
  });

  test("a single-reviewer finding renders under that reviewer's severity, unchanged", () => {
    const env = consolidate(
      { reviewer: "claude", verdict: "block", findings: [{ lens: "bug", file: "a.ts", line: 1, severity: "must-fix", finding: "npe" }] },
      { reviewer: "codex", verdict: "approve", findings: [] },
      "s",
    );
    const claude = renderAgentComment(env, "claude", AT);
    expect(claude).toContain("### Must-fix (1)");
    expect(claude).toContain("**[bug]** `a.ts:1` — npe _(raised by claude)_");
    const codex = renderAgentComment(env, "codex", AT);
    expect(codex).toContain("No findings.");
  });
});
