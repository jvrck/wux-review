import { z } from "zod";
import { WuxReviewError } from "../runtime/errors";
import type { Lens } from "./lenses";
import { refutationLedgerSection } from "./refutation";
import type { Finding, RefutationEntry, ReviewerName, ReviewResult, Severity } from "./types";

// The output contract both reviewers must satisfy. Asking for findings only
// (severity-tagged) — the verdict is computed from them — removes any chance of
// a self-reported verdict disagreeing with the findings it cites.
const findingSchema = z
  .object({
    lens: z.string().min(1),
    file: z.string(),
    line: z.number().int().nullable().default(null),
    severity: z.enum(["must-fix", "nice-fix", "nit"]),
    finding: z.string().min(1),
    // Runnable proof for a blocking finding (#101): a repro command a human could
    // run to see the defect. Optional (nits/nice-fixes need none, and round-1
    // must-fixes are accepted without it), but a must-fix WITHOUT a repro is
    // demotable if it was previously refuted — see refutation.ts.
    repro: z.string().optional(),
  })
  .strict();

const reportSchema = z.object({ findings: z.array(findingSchema) }).strict();

// Build the prompt fed to a reviewer. Diversity comes from the two models, so the
// core prompt — diff + full lens set + output contract — is identical for both.
// On a `--session` re-review, `priorFindings` carries THIS leg's own prior-round
// findings (never the other leg's — legs stay independent) so it reviews
// incrementally against the current diff; absent, the prompt is byte-for-byte the
// default one-shot prompt (#91).
export function buildReviewerPrompt(
  diff: string,
  lenses: Lens[],
  priorFindings?: Finding[],
  reviewer?: ReviewerName,
  ledger?: RefutationEntry[],
): string {
  const lensBlock = lenses.map((lens) => `- ${lens.name}: ${lens.prompt}`).join("\n");
  const ledgerSection = reviewer !== undefined && ledger !== undefined ? refutationLedgerSection(reviewer, ledger) : "";
  return `You are an independent code reviewer. Review ONLY the unified diff at the end of this message. Do not assume anything not present in the diff.

If this is a re-review in an existing session, treat the current diff as authoritative. Do not repeat prior-round findings unless the issue is still visible in the current diff.
${priorFindingsSection(priorFindings)}${ledgerSection}
Apply every one of these lenses:
${lensBlock}

Bucket each finding by severity:
- must-fix: correctness bugs, broken invariants, security issues, missing/wrong tests for changed code, out-of-scope changes.
- nice-fix: simplification, reuse, minor efficiency, clarity.
- nit: style/cosmetic.

Every must-fix (including any [security] finding) MUST carry a "repro": a runnable command a reviewer could execute to see the defect — a \`node -e '...'\` one-liner, a failing test invocation, a \`curl\`, etc. A blocking finding asserted WITHOUT a repro is accepted this round, but if it was previously refuted (see any refuted-findings list above) and you re-raise it without a NEW repro that survives that counter-evidence, it will be demoted to advisory and tagged \`persistent-unproven\`. Provide the repro so a genuine blocker stands. Omit "repro" for nice-fix / nit findings.

Output ONLY a single fenced JSON block (no prose before or after) of exactly this shape:

\`\`\`json
{
  "findings": [
    { "lens": "<lens name>", "file": "<path>", "line": <number or null>, "severity": "must-fix" | "nice-fix" | "nit", "finding": "<one-line rationale>", "repro": "<runnable command; required for must-fix, omit otherwise>" }
  ]
}
\`\`\`

An empty "findings" array means you approve with no findings. Use the exact lens names listed above. Use null for "line" when a finding is not tied to a specific line.

DIFF UNDER REVIEW:
${diff}`;
}

// The re-review section, inserted only on a `--session` re-review (when
// `priorFindings` is defined). It (a) frames the diff below as the FULL current
// change and (b) grounds the "don't re-raise resolved findings" instruction in
// this leg's CONCRETE prior items so the leg reviews incrementally without
// re-deriving a verdict from scratch. `undefined` (the default one-shot path, and
// the first round of a session before any state exists) yields "" — the prompt is
// then byte-identical to the pre-#91 prompt. An empty array is a distinct signal:
// the leg approved last round, so it is told to hold that approval absent a new
// defect.
//
// #94: both branches open with the same "full diff" frame. The diff handed to a
// re-review has ALWAYS been the full cumulative base...head (getDiff → `gh pr
// diff` / a three-dot range — see diff.ts; the headless legs are one-shot, so
// nothing is ever scoped to "commits since the last review"). But the pre-#94
// wording — "a genuine defect in the current changed lines", "do not introduce
// new findings on unchanged code" — invited a leg to narrow its attention to the
// latest fix commit and report earlier-commit content (e.g. tests added in commit
// A) as *missing*, a false must-fix. The frame makes the invariant explicit to the
// model: read the diff as the RESULTING branch state (added + context lines — not
// removed `-` lines), so nothing present in that state may be called missing, while
// genuinely-absent coverage (including a test the diff DELETES) still blocks (#97).
// Prior findings stay context only — they never re-scope the diff.
function priorFindingsSection(priorFindings?: Finding[]): string {
  if (priorFindings === undefined) {
    return "";
  }
  const frame =
    "\nThis is a re-review in an existing session. The DIFF UNDER REVIEW below is the FULL current change for this branch/PR — the " +
    "complete base...head diff across every commit on the branch, not just the latest commit. Read it as the RESULTING state of the " +
    "branch: lines added (`+`) and unchanged context lines are what the code now contains; lines removed (`-`) are gone. Do NOT report " +
    "anything as missing, absent, or uncovered when it is present in that resulting state (for example, tests added in an earlier commit " +
    "ARE in this diff — do not call them missing). This does NOT lower the bar for genuinely-absent coverage. Code changed in this diff " +
    "that has no test in that resulting state is still a valid must-fix — and a test this diff DELETES (it appears only on removed `-` " +
    "lines) is absent, not present. Your prior-round findings below are context only, to keep the review incremental; they do not " +
    "re-scope the diff.\n";
  if (priorFindings.length === 0) {
    return (
      frame +
      "In the previous round you reported no findings and approved this change. Hold that approval: raise a finding now ONLY if it is a " +
      "genuine defect introduced by changes made since your approval; do not re-open code you already accepted — the genuinely-absent-" +
      "coverage rule above governs newly-changed code, not code you already signed off on.\n"
    );
  }
  // Each prior finding is listed on ONE line. The `finding`/`lens`/`file` text is
  // model-generated from a prior round (ultimately derived from the untrusted
  // diff), so collapse any embedded newlines/whitespace to single spaces: a
  // multi-line value must not break the bullet structure or smuggle a new
  // instruction line into the prompt (a code fence needs its own line to act as
  // one, so one-lining defuses that too). The diff itself is necessarily shown raw
  // — a code reviewer must see it — so this is structural hardening of the list,
  // not a claim of full injection resistance.
  const list = priorFindings
    .map((f) => `- [${f.severity}] ${f.line === null ? inlineText(f.file) : `${inlineText(f.file)}:${f.line}`} (${inlineText(f.lens)}) — ${inlineText(f.finding)}`)
    .join("\n");
  return (
    frame +
    "In the previous round you reported these findings:\n" +
    `${list}\n` +
    "Re-raise one of these ONLY if it is still visible in this full diff — a finding that was resolved must NOT reappear. " +
    "Do not escalate a prior finding's severity, and do not raise a new must-fix unless it is a genuine, newly-introduced defect in this diff.\n"
  );
}

// Collapse whitespace (incl. newlines) to single spaces and trim, so a prior
// finding's text stays on one line in the re-review list above.
function inlineText(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

// Parse a reviewer's raw output into a structured result. The verdict is
// computed (block iff any must-fix). Unparseable output is a hard error — a
// reviewer that can't be understood is not a silent approval.
export function parseReport(reviewer: ReviewerName, raw: string): ReviewResult {
  const json = extractJson(raw);
  if (json === undefined) {
    throw new WuxReviewError(`${reviewer} reviewer returned no JSON findings block`);
  }
  let data: unknown;
  try {
    data = JSON.parse(json);
  } catch (err) {
    throw new WuxReviewError(`${reviewer} reviewer returned invalid JSON: ${(err as Error).message}`);
  }
  const parsed = reportSchema.safeParse(data);
  if (!parsed.success) {
    const detail = parsed.error.issues.map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`).join("; ");
    throw new WuxReviewError(`${reviewer} reviewer returned an invalid findings object: ${detail}`);
  }
  const findings: Finding[] = parsed.data.findings;
  const verdict = findings.some((f) => severityBlocks(f.severity)) ? "block" : "approve";
  return { reviewer, findings, verdict };
}

function severityBlocks(severity: Severity): boolean {
  return severity === "must-fix";
}

// Pull the JSON object out of a reviewer's raw output with a string-aware
// balanced-brace scan. Reviewers are asked to emit a single fenced ```json
// object, but on fence-heavy diffs the object's own string values quote ```
// code fences and embed `{`/`}` braces (the model wraps its answer in ```json
// while echoing ```py/```ts hunks from the diff inside a "finding"). A
// non-greedy fence regex closes at the FIRST ``` and returns a fragment, not
// the whole object, and a naive first-`{`/last-`}` slice mis-cuts too. This
// scan walks the text tracking JSON string state (honouring `\"` escapes) so
// `{`, `}`, and ``` characters INSIDE string values are ignored, and returns
// the LAST complete balanced top-level `{...}` object — the prompt's contract
// example is emitted before the real answer, so last wins. Quotes and braces
// are only significant once we're inside an object, so a stray quote or brace
// in a prose preamble can't swallow the real object. Returns undefined when
// there is no balanced object.
function extractJson(raw: string): string | undefined {
  let depth = 0;
  let start = -1;
  let inString = false;
  let escaped = false;
  let lastObject: string | undefined;

  for (let i = 0; i < raw.length; i++) {
    const ch = raw[i]!;

    if (inString) {
      if (escaped) {
        escaped = false;
      } else if (ch === "\\") {
        escaped = true;
      } else if (ch === '"') {
        inString = false;
      }
      continue;
    }

    if (depth === 0) {
      // Outside any object: only an opening brace matters; prose (including
      // stray quotes/backticks/close-braces) is skipped.
      if (ch === "{") {
        depth = 1;
        start = i;
      }
      continue;
    }

    // Inside an object, outside a string.
    if (ch === '"') {
      inString = true;
    } else if (ch === "{") {
      depth++;
    } else if (ch === "}") {
      depth--;
      if (depth === 0 && start !== -1) {
        lastObject = raw.slice(start, i + 1);
        start = -1;
      }
    }
  }

  return lastObject;
}
