// Resolving the review target is pure: it maps the parsed CLI inputs to a
// descriptor. Touching git/gh happens later in `getDiff` (diff.ts), so this
// layer is trivially testable.

export type Target =
  | { kind: "pr"; pr: number }
  | { kind: "range"; range: string }
  | { kind: "worktree" };

// `parseReviewArgs` already guarantees `ref` and `pr` are not both set.
export function resolveTarget(input: { ref?: string; pr?: number }): Target {
  if (input.pr !== undefined) {
    return { kind: "pr", pr: input.pr };
  }
  const ref = input.ref;
  if (ref === undefined) {
    return { kind: "worktree" };
  }
  // An explicit range (`main..HEAD` / `main...HEAD`) is used verbatim; a single
  // ref reviews the changes on HEAD since that ref (three-dot, like wux's
  // dual-review branch mode).
  if (ref.includes("..")) {
    return { kind: "range", range: ref };
  }
  return { kind: "range", range: `${ref}...HEAD` };
}

export function describeTarget(target: Target): string {
  switch (target.kind) {
    case "pr":
      return `PR #${target.pr}`;
    case "range":
      return target.range;
    case "worktree":
      return "working tree";
  }
}
