import { run as defaultRun, type Run } from "../runtime/exec";
import { WuxReviewError } from "../runtime/errors";
import type { ConsolidatedFinding, VerdictEnvelope } from "./consolidate";
import type { ReviewerName, Severity } from "./types";

// One comment per reviewer, each keyed by its own hidden marker so a re-review
// updates that reviewer's comment in place — exactly one Claude and one Codex
// comment per PR, never a duplicate pile.
const REVIEWERS: ReviewerName[] = ["claude", "codex"];
const markerFor = (reviewer: ReviewerName): string => `<!-- dual-review:${reviewer} -->`;
// The pre-#62 single-comment marker. Swept on post so upgrading from the old
// consolidated comment to the per-agent comments leaves no orphan behind.
const LEGACY_MARKER = "<!-- wux-review -->";

// The positive per-leg result of a post: which reviewer, the comment URL it
// landed at (from `.html_url`), and the round it carried (#100). The CLI prints
// these as a "verdict posted (round N)" signal so a driving session gets a clear
// completion signal without polling the PR — the upsert edits comments in place,
// so the PR's comment count never changes to signal a new verdict.
export interface PostResult {
  reviewer: ReviewerName;
  url: string;
  round: number;
}

// Post per-agent findings as one comment per reviewer, updating each in place if
// it already exists. Additive: never changes the verdict and never edits code.
// `run` is injected so the gh boundary is mockable; `now` supplies the header's
// "updated" timestamp (injected so tests are deterministic). Returns each leg's
// comment URL + round (#100).
export async function postToPr(
  pr: number,
  envelope: VerdictEnvelope,
  run: Run = defaultRun,
  // Second-precision ISO (trim the `.mmm`) — the "updated" stamp is a human/at-a-
  // glance marker, so milliseconds are noise; this also matches the documented
  // header examples.
  now: () => string = () => new Date().toISOString().replace(/\.\d{3}Z$/, "Z"),
): Promise<PostResult[]> {
  const repo = (await capture(run, ["gh", "repo", "view", "--json", "nameWithOwner", "--jq", ".nameWithOwner"])).trim();
  if (repo === "") {
    throw new WuxReviewError("--post-to-pr: could not resolve the repository (is this a gh-tracked checkout?)");
  }
  // Scope updates to OUR OWN marker comments: matching a marker alone would let a
  // comment authored by anyone else (who happened to prefix it) be overwritten.
  // GitHub usernames are `[A-Za-z0-9-]`, so embedding the viewer login is safe.
  const viewer = (await capture(run, ["gh", "api", "user", "--jq", ".login"])).trim();

  // Remove any legacy consolidated comment first, so an upgrade ends with exactly
  // one Claude and one Codex comment — no orphaned old comment alongside them.
  await removeLegacyComments(run, repo, viewer, pr);

  // One "updated" stamp for both legs of this post (they land together), and the
  // round from the envelope (absent → round 1, e.g. a one-shot --post-to-pr).
  const updatedAt = now();
  const round = envelope.round ?? 1;
  const results: PostResult[] = [];
  for (const reviewer of REVIEWERS) {
    const marker = markerFor(reviewer);
    const body = `${marker}\n\n${renderAgentComment(envelope, reviewer, updatedAt)}`;
    const url = await upsertComment(run, repo, viewer, pr, marker, body);
    results.push({ reviewer, url, round });
  }
  return results;
}

// Delete this viewer's pre-#62 `<!-- wux-review -->` comment(s), if any. The
// legacy marker can never match a new per-agent marker (different prefix), so
// this only ever removes the old consolidated comment.
async function removeLegacyComments(run: Run, repo: string, viewer: string, pr: number): Promise<void> {
  const ids = (
    await capture(run, [
      "gh",
      "api",
      `repos/${repo}/issues/${pr}/comments`,
      "--paginate",
      "--jq",
      `.[] | select((.body | startswith("${LEGACY_MARKER}")) and .user.login == "${viewer}") | .id`,
    ])
  )
    .trim()
    .split(/\s+/)
    .filter(Boolean);
  for (const id of ids) {
    await capture(run, ["gh", "api", "-X", "DELETE", `repos/${repo}/issues/comments/${id}`]);
  }
}

// Find this viewer's existing comment for the marker and PATCH it, else POST a
// new one. Streams matching ids across all pages and picks the last locally
// (some gh versions reject `--slurp` with `--jq`, so keep pagination compatible).
// Returns the resulting comment's `.html_url` (#100), so the caller can surface it.
async function upsertComment(
  run: Run,
  repo: string,
  viewer: string,
  pr: number,
  marker: string,
  body: string,
): Promise<string> {
  const existing = (
    await capture(run, [
      "gh",
      "api",
      `repos/${repo}/issues/${pr}/comments`,
      "--paginate",
      "--jq",
      `.[] | select((.body | startswith("${marker}")) and .user.login == "${viewer}") | .id`,
    ])
  )
    .trim()
    .split(/\s+/)
    .filter(Boolean)
    .at(-1);

  const write = existing
    ? ["gh", "api", "-X", "PATCH", `repos/${repo}/issues/comments/${existing}`, "-f", `body=${body}`, "--jq", ".html_url"]
    : ["gh", "api", "-X", "POST", `repos/${repo}/issues/${pr}/comments`, "-f", `body=${body}`, "--jq", ".html_url"];
  return (await capture(run, write)).trim();
}

// Render one reviewer's section of the verdict: that reviewer's own verdict and
// the findings it raised, each bucketed by the severity THAT reviewer assigned —
// not the consolidated max — so a reviewer is never shown an escalated severity
// in its own comment. A finding both raised shows `raised by claude, codex`, so
// cross-agreement stays visible in each comment. `updatedAt` (an ISO timestamp)
// and the envelope's round drive the visible header line (#100) that makes an
// in-place re-review edit detectable without diffing bodies.
export function renderAgentComment(envelope: VerdictEnvelope, reviewer: ReviewerName, updatedAt: string): string {
  // Walk the consolidated buckets and re-file each of this reviewer's findings
  // under its OWN severity (perReviewer), falling back to the consolidated bucket
  // when a per-reviewer severity is absent. The consolidated envelope is never
  // mutated — buckets here are local.
  const mine: Record<Severity, ConsolidatedFinding[]> = { "must-fix": [], "nice-fix": [], nit: [] };
  const consolidated: [Severity, ConsolidatedFinding[]][] = [
    ["must-fix", envelope.must_fix],
    ["nice-fix", envelope.nice_fix],
    ["nit", envelope.nits],
  ];
  for (const [severity, findings] of consolidated) {
    for (const finding of findings) {
      if (!finding.raised_by.includes(reviewer)) {
        continue;
      }
      const own = finding.perReviewer?.[reviewer] ?? severity;
      mine[own].push(finding);
    }
  }

  const lines: string[] = [];
  // Visible header (#100): round number, updated-at, and this leg's verdict. Since
  // the comment is upserted in place (the count never changes), this is how a
  // human or orchestrator detects a fresh re-review verdict — by the round marker /
  // updated timestamp, never by a new comment appearing.
  const headerVerdict = envelope.reviewers[reviewer] === "block" ? "must-fix" : "clean";
  lines.push(`**Dual-review (${reviewer}) — round ${envelope.round ?? 1} · updated ${updatedAt} · verdict: ${headerVerdict}**`);
  lines.push("");
  lines.push(`## wux-review · ${reviewer}: ${envelope.reviewers[reviewer] === "block" ? "🔴 block" : "🟢 approve"}`);

  section(lines, "Must-fix", mine["must-fix"], reviewer);
  section(lines, "Nice-fix", mine["nice-fix"], reviewer);
  section(lines, "Nits", mine.nit, reviewer);

  if (mine["must-fix"].length === 0 && mine["nice-fix"].length === 0 && mine.nit.length === 0) {
    lines.push("");
    lines.push("No findings.");
  }
  lines.push("");
  lines.push(`<sub>session \`${envelope.session}\`</sub>`);
  return lines.join("\n");
}

function section(lines: string[], title: string, findings: ConsolidatedFinding[], reviewer: ReviewerName): void {
  if (findings.length === 0) {
    return;
  }
  lines.push("");
  lines.push(`### ${title} (${findings.length})`);
  for (const finding of findings) {
    const where = finding.line === null ? `\`${finding.file}\`` : `\`${finding.file}:${finding.line}\``;
    // A finding the refutation-ledger guard demoted for THIS leg is tagged, so a
    // human sees it was a blocker that lost its block power to the ledger — demoted,
    // not deleted; the full history stays visible (#101).
    const tag = finding.persistentUnproven?.[reviewer] === true ? " — `persistent-unproven`" : "";
    lines.push(`- **[${finding.lens}]** ${where} — ${finding.finding} _(raised by ${finding.raised_by.join(", ")})_${tag}`);
    // Show this leg's runnable proof inline so a human can verify / re-run it (#101).
    const repro = finding.repro?.[reviewer];
    if (repro !== undefined && repro.trim() !== "") {
      lines.push(`  - repro: ${inlineCode(repro.replace(/\s+/g, " ").trim())}`);
    }
  }
}

// Wrap text as a Markdown inline-code span that survives backticks in the content
// (common in shell command substitution) — CommonMark: fence with one more
// backtick than the longest run inside, and pad with a space when the content
// starts/ends with a backtick. A plain `...` span would break on an embedded `.
function inlineCode(text: string): string {
  const longestRun = Math.max(0, ...(text.match(/`+/g) ?? []).map((run) => run.length));
  const fence = "`".repeat(longestRun + 1);
  const pad = text.startsWith("`") || text.endsWith("`") ? " " : "";
  return `${fence}${pad}${text}${pad}${fence}`;
}

async function capture(run: Run, cmd: string[]): Promise<string> {
  const result = await run(cmd);
  if (result.code !== 0) {
    const detail = result.stderr.trim() || `exit ${result.code}`;
    // Show the command but never the (potentially large) comment body payload.
    const label = cmd.filter((arg) => !arg.startsWith("body=")).join(" ");
    throw new WuxReviewError(`${label}: ${detail}`);
  }
  return result.stdout;
}
