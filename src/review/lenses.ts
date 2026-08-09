import { WuxReviewError } from "../runtime/errors";
import type { WuxReviewConfig } from "./config";

// A lens is the review angle (content), kept separate from the engine
// (mechanics). Both reviewers run the *full* resolved set — diversity comes from
// the two models, not from splitting lenses between them.
export interface Lens {
  name: string;
  prompt: string;
}

export const DEFAULT_LENSES: Lens[] = [
  {
    name: "correctness",
    prompt:
      "Does the change do what it intends? Logic errors, wrong conditions, off-by-one, broken invariants, incorrect API or contract use.",
  },
  {
    name: "edge-cases",
    prompt:
      "Boundary and failure inputs: empty/null/zero, very large values, concurrency, partial failure, resource exhaustion, and unusual-but-valid inputs.",
  },
  {
    name: "security",
    prompt:
      "Injection, unsafe input handling, secret/credential exposure, unsafe deserialization, path traversal, privilege mistakes, unsafe shell or SQL.",
  },
  {
    name: "regression",
    prompt:
      "Does the change break existing behavior, callers, or tests? Backward-incompatible changes, removed or renamed surfaces, missing test updates.",
  },
  {
    name: "clarity",
    prompt:
      "Readability and maintainability: confusing names, dead or duplicated code, missing or wrong comments, needless complexity, inconsistent style.",
  },
];

const DEFAULT_BY_NAME: ReadonlyMap<string, Lens> = new Map(DEFAULT_LENSES.map((lens) => [lens.name, lens]));

export interface ResolveLensesInput {
  cliLenses?: string[]; // from --lenses
  config?: WuxReviewConfig; // from .wux-review.yml
}

// Precedence for the active set: --lenses > .wux-review.yml `lenses` > the
// default set. Names resolve against the defaults plus any `extra_lenses` the
// config defines; an unknown name is a clean error.
export function resolveLenses(input: ResolveLensesInput = {}): Lens[] {
  const registry = new Map(DEFAULT_BY_NAME);
  for (const lens of input.config?.extraLenses ?? []) {
    registry.set(lens.name, lens);
  }

  // `--lenses` (non-empty, enforced by the parser) wins; else the config's
  // `lenses` (non-empty, enforced by the schema); else the default set. Only an
  // *absent* (undefined) set falls through — an explicitly empty set is NOT
  // silently replaced by the defaults; it trips the guard below.
  const names = input.cliLenses ?? input.config?.lenses ?? DEFAULT_LENSES.map((lens) => lens.name);

  const resolved: Lens[] = [];
  const seen = new Set<string>();
  for (const name of names) {
    if (seen.has(name)) {
      continue;
    }
    seen.add(name);
    const lens = registry.get(name);
    if (!lens) {
      throw new WuxReviewError(`unknown lens: ${name} (define it under extra_lenses in .wux-review.yml)`);
    }
    resolved.push(lens);
  }
  if (resolved.length === 0) {
    throw new WuxReviewError("no lenses resolved (an empty lens set is not valid)");
  }
  return resolved;
}
