import { Buffer } from "node:buffer";
import { run as defaultRun, type Run } from "../runtime/exec";
import { WuxReviewError } from "../runtime/errors";
import type { ConsolidatedFinding, VerdictEnvelope } from "./consolidate";
import type { ReviewerName, Severity } from "./types";

// One comment per reviewer for every round. The marker stays first for tooling;
// the round marker preserves a visible red-to-green history on the PR.
const REVIEWERS: ReviewerName[] = ["claude", "codex"];
const markerFor = (reviewer: ReviewerName): string => `<!-- dual-review:${reviewer} -->`;
// The pre-#62 single-comment marker. Swept on post so upgrading from the old
// consolidated comment to the per-agent comments leaves no orphan behind.
const LEGACY_MARKER = "<!-- wux-review -->";

// The positive per-leg result of a post: which reviewer, the comment URL it
// landed at (from `.html_url`), and the round it carried (#100). The CLI prints
// these as a "verdict posted (round N)" signal so a driving session gets a clear
// completion signal without polling the PR — every result has a fresh URL.
export interface PostResult {
  reviewer: ReviewerName;
  url: string;
  round: number;
}

// Post per-agent findings as new comments every round. Additive: never changes
// the verdict and never edits code.
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
  // Scope reads and pointer edits to OUR OWN marker comments: matching a marker
  // alone would let another author influence our history.
  // GitHub usernames are `[A-Za-z0-9-]`, so embedding the viewer login is safe.
  const viewer = (await capture(run, ["gh", "api", "user", "--jq", ".login"])).trim();

  // Keep the legacy sweep for the obsolete consolidated marker.
  await removeLegacyComments(run, repo, viewer, pr);

  const previous = await reviewerComments(run, repo, viewer, pr);
  const previousRound = priorRound(previous);
  // A session-derived round is a lower bound; PR history makes one-shot rounds
  // count up as well.
  const round = Math.max(envelope.round ?? 1, previousRound + 1);
  const postedEnvelope = { ...envelope, round };
  const updatedAt = now();
  const results: PostResult[] = [];
  for (const reviewer of REVIEWERS) {
    const marker = markerFor(reviewer);
    const body = `${marker}\n<!-- dual-review:round=${round} -->\n\n${renderAgentComment(postedEnvelope, reviewer, updatedAt)}`;
    const url = await postComment(run, repo, pr, body);
    results.push({ reviewer, url, round });
  }
  for (const comment of supersededComments(previous, previousRound)) {
    const replacement = results.find((result) => result.reviewer === comment.reviewer);
    if (replacement === undefined || hasSupersededPointer(comment.body)) continue;
    try {
      await capture(run, ["gh", "api", "-X", "PATCH", `repos/${repo}/issues/comments/${comment.id}`, "-f", `body=${withSupersededPointer(comment.body, round, replacement.url)}`]);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      process.stderr.write(`wux-review: warning: could not mark prior ${comment.reviewer} comment superseded: ${message}\n`);
    }
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

interface ReviewerComment {
  id: string;
  body: string;
  reviewer: ReviewerName;
}

async function reviewerComments(run: Run, repo: string, viewer: string, pr: number): Promise<ReviewerComment[]> {
  const encoded = await capture(run, [
    "gh", "api", `repos/${repo}/issues/${pr}/comments`, "--paginate", "--jq",
    `.[] | select((.body | startswith("<!-- dual-review:")) and .user.login == "${viewer}") | [.id, .body] | @base64`,
  ]);
  return encoded.trim().split(/\s+/).filter(Boolean).flatMap((line) => {
    try {
      const [id, body] = JSON.parse(Buffer.from(line, "base64").toString("utf8")) as [unknown, unknown];
      const marker = typeof body === "string" ? body.match(/^<!-- dual-review:(claude|codex) -->/) : undefined;
      if ((typeof id !== "number" && typeof id !== "string") || typeof body !== "string" || marker === null || marker === undefined) return [];
      return [{ id: String(id), body, reviewer: marker[1] as ReviewerName }];
    } catch {
      throw new WuxReviewError("--post-to-pr: could not parse existing reviewer comments");
    }
  });
}

function commentRound(comment: ReviewerComment): number | undefined {
  const machine = comment.body.match(/^<!-- dual-review:round=(\d+) -->$/m);
  if (machine !== null) return Number(machine[1]);
  const visible = comment.body.match(/\bround (\d+)\b/);
  return visible === null ? undefined : Number(visible[1]);
}

function priorRound(comments: ReviewerComment[]): number {
  const known = comments.map(commentRound).filter((round): round is number => round !== undefined);
  // Pre-round-key comments may have no usable header: then treat each historic
  // comment as one prior round. Once any recorded/header round exists, it is the
  // authoritative monotonic sequence rather than the two-comments-per-round count.
  return known.length === 0 ? Math.ceil(comments.length / REVIEWERS.length) : Math.max(...known);
}

// Only the immediately previous pair changes, and only once. Earlier rounds
// already point at the round that superseded them.
function supersededComments(comments: ReviewerComment[], previousRound: number): ReviewerComment[] {
  const known = comments.some((comment) => commentRound(comment) !== undefined);
  return comments.filter((comment) => known ? commentRound(comment) === previousRound : true);
}

function hasSupersededPointer(body: string): boolean {
  return body.split("\n", 3)[1]?.startsWith("> Superseded by round ") === true;
}

function withSupersededPointer(body: string, round: number, url: string): string {
  const newline = body.indexOf("\n");
  const pointer = `> Superseded by round ${round}: ${url}`;
  // Preserve the marker as byte zero for startswith-based tooling. Other than
  // this inserted line, the prior comment body remains byte-for-byte unchanged.
  return newline === -1 ? `${body}\n${pointer}` : `${body.slice(0, newline + 1)}${pointer}\n${body.slice(newline + 1)}`;
}

// Always create a new comment. PATCH is reserved for the optional one-line
// superseded pointer applied after both new comments have safely landed.
async function postComment(
  run: Run,
  repo: string,
  pr: number,
  body: string,
): Promise<string> {
  return (await capture(run, ["gh", "api", "-X", "POST", `repos/${repo}/issues/${pr}/comments`, "-f", `body=${body}`, "--jq", ".html_url"])).trim();
}

// Render one reviewer's section of the verdict: that reviewer's own verdict and
// the findings it raised, each bucketed by the severity THAT reviewer assigned —
// not the consolidated max — so a reviewer is never shown an escalated severity
// in its own comment. A finding both raised shows `raised by claude, codex`, so
// cross-agreement stays visible in each comment. `updatedAt` and the envelope's
// round drive the visible header line; historical comments stay intact.
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
  // Visible header: round number, reviewed PR head (when applicable), timestamp,
  // and this leg's verdict.
  const headerVerdict = envelope.reviewers[reviewer] === "block" ? "must-fix" : "clean";
  const head = envelope.head === undefined ? "" : ` · head ${envelope.head.slice(0, 12)}`;
  lines.push(`**Dual-review (${reviewer}) — round ${envelope.round ?? 1}${head} · updated ${updatedAt} · verdict: ${headerVerdict}**`);
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
    const where = finding.file === "" ? "`(general)`" : finding.line === null ? `\`${finding.file}\`` : `\`${finding.file}:${finding.line}\``;
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
