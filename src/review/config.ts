import { realpath } from "node:fs/promises";
import { isAbsolute, relative, sep } from "node:path";
import { z } from "zod";
import { WuxReviewError } from "../runtime/errors";

// Schema for `.wux-review.yml`. Mechanics stay in code; this file is content:
// which lenses to run, any repo-specific extra lenses, and reviewer model
// pinning (the model fields are consumed by the reviewer layer in #6).
// Every object is `.strict()` so a typo'd key (e.g. `modle:` for `model:`) is a
// clean config error rather than a silently-dropped field — important because
// the reviewer model fields gate model pinning in #6.
const lensSchema = z
  .object({
    name: z.string().min(1).refine((name) => name !== "default", {
      message: '"default" is reserved for the built-in lens set',
    }),
    prompt: z.string().min(1),
  })
  .strict();

const reviewerSchema = z
  .object({
    model: z.string().min(1).optional(),
  })
  .strict();

// The deterministic check step: a single shell command or an ordered list of
// them (run in sequence, fail-fast). Keeps wux-review portable — a non-Bun repo
// points this at `pytest`/`cargo test`/etc. instead of the Bun default.
// Trim + require non-empty so a blank command (`check: " "`) — which `bash -c`
// treats as a successful no-op and would silently disable the gate — is rejected.
const checkCommand = z.string().trim().min(1, "check command must not be blank");
const checkSchema = z.union([checkCommand, z.array(checkCommand).min(1, "must list at least one check command")]);

export const configSchema = z
  .object({
    lenses: z.array(z.string().min(1)).min(1, "must list at least one lens").optional(),
    extra_lenses: z.array(lensSchema).optional(),
    check: checkSchema.optional(),
    reviewers: z
      .object({
        claude: reviewerSchema.optional(),
        codex: reviewerSchema.optional(),
      })
      .strict()
      .optional(),
  })
  .strict();

export interface ReviewerConfig {
  model?: string;
}

export interface WuxReviewConfig {
  lenses?: string[];
  extraLenses?: { name: string; prompt: string }[];
  // Normalized to a command list; a bare string in the YAML becomes `[string]`.
  check?: string[];
  reviewers?: { claude?: ReviewerConfig; codex?: ReviewerConfig };
}

// Parse + validate a `.wux-review.yml` document. An empty document is the empty
// config.
export function parseConfig(text: string): WuxReviewConfig {
  let raw: unknown;
  try {
    raw = Bun.YAML.parse(text);
  } catch (err) {
    throw new WuxReviewError(`.wux-review.yml: invalid YAML: ${(err as Error).message}`);
  }
  if (raw === null || raw === undefined) {
    return {};
  }
  const parsed = configSchema.safeParse(raw);
  if (!parsed.success) {
    const detail = parsed.error.issues
      .map((issue) => `${issue.path.join(".") || "(root)"}: ${issue.message}`)
      .join("; ");
    throw new WuxReviewError(`.wux-review.yml: ${detail}`);
  }
  const data = parsed.data;
  return {
    lenses: data.lenses,
    extraLenses: data.extra_lenses,
    check: data.check === undefined ? undefined : Array.isArray(data.check) ? data.check : [data.check],
    reviewers: data.reviewers,
  };
}

// Load `.wux-review.yml`. By default it is discovered at the **git repo root**
// (so the config is found no matter which subdirectory the tool is invoked
// from), falling back to the current directory when not inside a git repo. An
// absent file yields the empty config. `dir` overrides discovery (used in tests).
export async function loadConfig(dir?: string): Promise<WuxReviewConfig> {
  const root = dir ?? (await repoRoot()) ?? process.cwd();
  const file = Bun.file(`${root}/.wux-review.yml`);
  if (!(await file.exists())) {
    return {};
  }
  let text: string;
  try {
    text = await file.text();
  } catch (err) {
    throw new WuxReviewError(`.wux-review.yml: cannot read: ${(err as Error).message}`);
  }
  return parseConfig(text);
}

export async function repoRoot(): Promise<string | undefined> {
  // Checkout discovery must describe the cwd itself, rather than a repository
  // selected by a caller's ambient Git environment.
  const environment = { ...process.env };
  delete environment.GIT_DIR;
  delete environment.GIT_WORK_TREE;
  delete environment.GIT_COMMON_DIR;
  delete environment.GIT_INDEX_FILE;
  delete environment.GIT_NAMESPACE;
  const proc = Bun.spawn(["git", "rev-parse", "--show-toplevel"], {
    stdout: "pipe",
    stderr: "pipe",
    env: environment,
  });
  const [out, err, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
  if (code !== 0) {
    if (/not a git repository/i.test(err)) return undefined;
    throw new WuxReviewError(err.trim() || "git rev-parse --show-toplevel failed");
  }
  const reportedRoot = out.replace(/\r?\n$/, "");
  if (reportedRoot === "") return undefined;
  const [root, cwd] = await Promise.all([
    realpath(reportedRoot).catch(() => reportedRoot),
    realpath(process.cwd()).catch(() => process.cwd()),
  ]);
  const pathFromRoot = relative(root, cwd);
  return pathFromRoot === "" || (!isAbsolute(pathFromRoot) && pathFromRoot !== ".." && !pathFromRoot.startsWith(`..${sep}`))
    ? root
    : undefined;
}
