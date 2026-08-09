// Shared review result types. A reviewer returns findings bucketed by severity;
// the per-reviewer verdict is *computed* from the findings (block iff any
// must-fix) rather than trusted from the model's self-report.
export type Severity = "must-fix" | "nice-fix" | "nit";

export type Verdict = "block" | "approve";

export type ReviewerName = "claude" | "codex";

export type ObservableLifecycleState =
  | "pending"
  | "running"
  | "completed"
  | "failed"
  | "timed_out"
  | "tainted"
  | "interrupted"
  | "reconciled";

export interface ObservableControlEvent {
  action: "send" | "interrupt" | "handoff" | "stop" | "invalid-events";
  at: string;
  actor: string;
}

// Durable identity for one observable reviewer attempt. The evidence
// directory is the Wux runDir discovered through `wux read --json`; resultPath is
// its single atomically-published verdict source. A Codex retry records another
// attempt rather than overwriting the first attempt's evidence.
export interface LegExecutionEvidence {
  reviewer: ReviewerName;
  childName: string;
  attempt: number;
  evidencePath: string;
  resultPath: string;
  resultId: string;
  promptSha256: string;
  // Exact safe-slug bootstrap stem used only to reconcile a parent interruption.
  // Optional so #111/#112 session state remains readable after this additive
  // lifecycle contract lands.
  transientBase?: string;
  // Recovery-only capability used to authenticate the adapter's exact-child
  // cleanup marker. It is persisted only in the private observable-round
  // journal and is stripped before evidence enters ordinary session history.
  ownedCleanupKey?: string;
  // Byte-exact Wux event prefix observed by the live parent. Reconciliation
  // verifies this checkpoint before trusting any later events, so controls
  // cannot be rewritten away while the parent is absent.
  eventPrefix?: {
    bytes: number;
    sha256: string;
  };
  // Durable proof that the generation-matched release was acknowledged, its
  // bootstrap was withdrawn, and Wux then observed the wrapper inactive.
  wrapperExitedNormally?: boolean;
  // Wrapper-owned bootstrap paths retained across a parent interruption.
  // These stay in the private recovery journal and are independently
  // revalidated before reconciliation removes them.
  cleanupFiles?: string[];
  cleanupDir?: string;
}

export interface ReviewRoundEvidence {
  round: number;
  claude: LegExecutionEvidence[];
  codex: LegExecutionEvidence[];
}

export interface Finding {
  lens: string;
  file: string;
  line: number | null;
  severity: Severity;
  finding: string;
  // A runnable command that demonstrates the defect (e.g. a `node -e` one-liner, a
  // failing test invocation) (#101). Leg prompts ask for it on every must-fix /
  // [security] finding. A must-fix carrying a repro is *proven* and is immune to
  // refutation-ledger demotion; a must-fix without one is accepted in round 1 but
  // is demotable if it was previously refuted. Optional so one-shot findings and
  // pre-#101 state still parse. wux-review never EXECUTES it — it judges only; the
  // repro is the concrete, falsifiable evidence a blocker must carry, not something
  // the tool runs.
  repro?: string;
  // Set when the refutation-ledger guard demoted this finding from a must-fix to
  // advisory because it was previously refuted (with evidence) and re-raised
  // without new proof (#101). Demoted ≠ deleted: it still surfaces, tagged
  // `persistent-unproven`, for the human. Never persisted as a leg's own output;
  // it is an out-of-band marker like the consolidated `perReviewer`.
  persistentUnproven?: boolean;
}

// One refuted finding recorded in a session's refutation ledger (#101): the
// finding's identity key (findingKey — so a re-raise matches), a human-readable
// summary + the refutation evidence (both shown to the leg each round and in the
// verdict comment), and the round the refutation was recorded.
export interface RefutationEntry {
  key: string;
  finding: string;
  evidence: string;
  round: number;
  // Every repro that has been refuted for this finding — accumulated across
  // refutations, so immunity on a re-raise requires a repro that is NOT among them
  // (#101). A proven blocker is immune only "until the repro is itself refuted":
  // re-attaching any already-refuted repro does not survive, and cycling back to an
  // earlier refuted repro cannot re-grant immunity. Empty when the finding was
  // unproven (no repro) at every refutation.
  refutedRepros: string[];
}

// A refutation supplied by the worker (via `--refutations <file>`): the finding it
// falsified (identified the same way findings are keyed) plus the counter-evidence
// (a counter-repro, a passing CI note). wux-review keys it and records it in the
// per-leg ledger; it never executes anything. (#101)
export interface Refutation {
  reviewer: ReviewerName;
  file: string;
  line: number | null;
  lens: string;
  finding: string;
  evidence: string;
}

export interface ReviewResult {
  reviewer: ReviewerName;
  findings: Finding[];
  verdict: Verdict;
}

// Persisted per-session review state (#91): the last `ReviewResult` for each
// reviewer leg, keyed by session id on disk (see session-state.ts). A `--session`
// re-review loads this so each leg reviews INCREMENTALLY against its OWN prior
// findings instead of context-free — the fix for re-review oscillation.
// `--end-session` clears it. `version` guards the on-disk schema so a stale file
// is ignored rather than mis-read.
export interface SessionState {
  version: 1;
  // The number of reviews performed in this session so far (#100). The pipeline
  // reads it to stamp the NEXT round on the verdict envelope, then persists the
  // incremented value. Optional so a pre-#100 state file (no `round`) still loads —
  // the loader defaults it to 0, making the first re-review after an upgrade round 1.
  round?: number;
  results: { claude: ReviewResult; codex: ReviewResult };
  // Per-leg accumulated "sticky" set: the finding identities (findingKey) each leg
  // has APPROVED-WITH earlier in the session. The sticky-approve guard demotes any
  // later escalation of one of these to a blocking must-fix. Persisted across
  // intervening BLOCK rounds (not just the last round), so a leg cannot revive a
  // subjective flip on a point it once accepted after an unrelated block clears.
  sticky: { claude: string[]; codex: string[] };
  // Per-leg refutation ledger (#101): findings the worker has refuted with
  // evidence. Each round the leg is shown its own ledger, and the guard demotes any
  // refuted must-fix it re-raises WITHOUT a repro (proven blockers, which carry a
  // repro, are immune). Optional so a pre-#101 state file still loads — the loader
  // defaults an absent ledger to empty sets.
  ledger?: { claude: RefutationEntry[]; codex: RefutationEntry[] };
  // Candidate observable child runs, grouped by review round. Optional so every
  // released pre-#111 state file remains readable. Direct-headless rounds add no
  // entry; Codex retries are additive attempts within the same round/leg.
  children?: ReviewRoundEvidence[];
}
