import { z } from "zod";
import { findingKey } from "./consolidate";
import { WuxReviewError } from "../runtime/errors";
import type { Finding, RefutationEntry, Refutation, ReviewResult, ReviewerName } from "./types";

// Refutation protocol (#101). A reviewer leg can produce a confidently-wrong
// blocking finding and regenerate it across rounds despite refutation, deadlocking
// a PR. The paranoia is load-bearing (it drives the catch rate), so the fix strips
// *unilateral deadlock power* from UNPROVEN findings rather than the paranoia:
//
//   1. A must-fix should carry a runnable repro (proof). Prompted in prompt.ts.
//   2. The worker records refutations (counter-evidence) via `--refutations`; they
//      accumulate in the per-leg session ledger and are shown to the leg each round.
//   3. When a leg re-raises a refuted finding as a must-fix WITHOUT a repro, it is
//      demoted to advisory (nice-fix) and tagged `persistent-unproven` — demoted,
//      never deleted or suppressed. A must-fix that carries a repro is immune.
//
// wux-review is judges-only and never EXECUTES a repro or a refutation; "runnable
// proof" means the blocker must carry concrete, falsifiable evidence, not that the
// tool runs it. Symmetric across legs (this module is applied per-leg).

// The worker-supplied refutations file (`--refutations <path>`): a JSON array of
// refuted findings + evidence. Validated strictly so a malformed file is a clean,
// typed error (it is an explicit operator input, unlike best-effort session state).
const refutationSchema = z
  .object({
    reviewer: z.enum(["claude", "codex"]),
    file: z.string(),
    line: z.number().int().nullable().default(null),
    lens: z.string(),
    finding: z.string().min(1),
    evidence: z.string().min(1),
  })
  .strict();
const refutationsSchema = z.array(refutationSchema);

// Parse + validate a `--refutations` file body into refutations. A malformed file
// is a typed WuxReviewError (explicit operator input → fail loudly, don't degrade).
export function parseRefutations(raw: string): Refutation[] {
  let data: unknown;
  try {
    data = JSON.parse(raw);
  } catch (err) {
    throw new WuxReviewError(`--refutations: could not parse JSON: ${(err as Error).message}`);
  }
  const parsed = refutationsSchema.safeParse(data);
  if (!parsed.success) {
    const detail = parsed.error.issues.map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`).join("; ");
    throw new WuxReviewError(`--refutations: invalid refutations file: ${detail}`);
  }
  return parsed.data;
}

// The identity key for a refutation — the SAME key findings are matched by
// (findingKey ignores severity, so a re-raise at any severity matches). This is
// how a refuted finding is later recognised when the leg re-raises it.
export function refutationKey(r: Pick<Refutation, "file" | "line" | "lens" | "finding">): string {
  return findingKey({ file: r.file, line: r.line, lens: r.lens, finding: r.finding });
}

// Merge new refutations (for this round) into the prior per-leg ledger, deduping by
// key per leg (a repeated refutation refreshes its evidence + round, never
// duplicates). Captures the repro the refuted finding carried in the PRIOR round
// (`priorFindings`) so a later re-raise must supply a DIFFERENT repro to stay
// immune. Returns a new ledger; inputs are not mutated.
export function mergeLedger(
  prior: { claude: RefutationEntry[]; codex: RefutationEntry[] },
  refutations: Refutation[],
  round: number,
  priorFindings: { claude: Finding[]; codex: Finding[] },
): { claude: RefutationEntry[]; codex: RefutationEntry[] } {
  const next = {
    claude: new Map(prior.claude.map((e) => [e.key, e] as const)),
    codex: new Map(prior.codex.map((e) => [e.key, e] as const)),
  };
  for (const r of refutations) {
    const key = refutationKey(r);
    // Accumulate the repro being refuted (the one the finding carried in the prior
    // round) onto any existing entry — never overwrite, so a refutation repeated
    // after a round where the finding was absent cannot erase an earlier-refuted
    // repro, and cycling back to an earlier repro cannot re-grant immunity.
    const priorRepro = normalizeRepro(priorFindings[r.reviewer].find((f) => findingKey(f) === key)?.repro);
    const refutedRepros = new Set(next[r.reviewer].get(key)?.refutedRepros ?? []);
    if (priorRepro !== undefined) {
      refutedRepros.add(priorRepro);
    }
    next[r.reviewer].set(key, {
      key,
      finding: r.finding,
      evidence: r.evidence,
      round,
      refutedRepros: [...refutedRepros],
    });
  }
  return { claude: [...next.claude.values()], codex: [...next.codex.values()] };
}

// A finding's repro trimmed to a comparable form, or undefined when absent/blank.
function normalizeRepro(repro: string | undefined): string | undefined {
  const trimmed = repro?.trim();
  return trimmed !== undefined && trimmed !== "" ? trimmed : undefined;
}

// Does this finding carry NEW proof that survives its refutation? A must-fix is
// immune to demotion only if it carries a repro that has NOT already been refuted
// for it — re-attaching any already-refuted repro (or no repro) is not new proof.
// When the finding was unproven at every refutation (`refutedRepros` empty), any
// non-empty repro counts as new.
function hasNewProof(finding: Finding, refutedRepros: string[]): boolean {
  const repro = normalizeRepro(finding.repro);
  return repro !== undefined && !refutedRepros.includes(repro);
}

// Downgrade-after-refutation (#101), applied per-leg after the sticky-approve guard.
// A must-fix is demoted to advisory (nice-fix) + tagged `persistentUnproven` iff ALL
// of: (1) its identity is in this leg's refutation ledger (it was refuted with
// evidence); (2) it was raised in the PRIOR round (`priorKeys`) — a finding making
// its FIRST appearance is always accepted, even if a stale refutation names it, so a
// genuinely-new blocker is never demoted; and (3) it does not carry NEW proof (a
// repro differing from the refuted one — a proven blocker is immune only until its
// repro is itself refuted). Demoted findings still surface (never deleted). The
// verdict is recomputed; never auto-approves — a new or re-proven must-fix blocks.
export function applyRefutationLedger(
  current: ReviewResult,
  entries: RefutationEntry[],
  priorKeys: Set<string>,
): ReviewResult {
  if (entries.length === 0) {
    return current;
  }
  const byKey = new Map(entries.map((e) => [e.key, e] as const));
  let demoted = false;
  const findings: Finding[] = current.findings.map((finding) => {
    if (finding.severity !== "must-fix") {
      return finding;
    }
    const key = findingKey(finding);
    const entry = byKey.get(key);
    if (entry === undefined || !priorKeys.has(key) || hasNewProof(finding, entry.refutedRepros)) {
      return finding;
    }
    demoted = true;
    return { ...finding, severity: "nice-fix", persistentUnproven: true };
  });
  if (!demoted) {
    return current;
  }
  const verdict = findings.some((f) => f.severity === "must-fix") ? "block" : "approve";
  return { reviewer: current.reviewer, findings, verdict };
}

// Render a leg's ledger as a prompt section shown to that leg each round (part 3):
// the refuted findings + their counter-evidence, so a re-raise is a deliberate act
// against known evidence, not amnesia. Empty ledger → "" (prompt unchanged). The
// text is one-lined defensively (it is ultimately derived from model/diff content).
export function refutationLedgerSection(reviewer: ReviewerName, entries: RefutationEntry[]): string {
  if (entries.length === 0) {
    return "";
  }
  const list = entries.map((e) => `- ${inlineText(e.finding)} — REFUTED (round ${e.round}): ${inlineText(e.evidence)}`).join("\n");
  return (
    "\nThe following of your prior findings were REFUTED with the evidence shown. Do NOT re-raise any of them as a blocking " +
    "must-fix unless you include a NEW runnable repro (a `repro` field) that survives this counter-evidence. A refuted must-fix " +
    "re-raised WITHOUT new proof will be demoted to advisory and tagged `persistent-unproven` — it will not block the verdict:\n" +
    `${list}\n`
  );
}

function inlineText(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}
