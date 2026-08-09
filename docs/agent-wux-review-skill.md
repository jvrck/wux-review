# Agent skill: wux-review

wux-review ships an optional, portable **skill** — a thin wrapper that just
invokes the `wux-review` CLI — for agents following a process. All substance
stays in the CLI; the skill never re-implements reviewing.

## What the skill does
Resolve the target (a PR number or a ref/range/working tree), run
`wux-review <target> --json` (optionally `--post-to-pr`), act on the verdict
(apply must-fixes — *the agent* owns the fix, the tool never edits code — and
re-review, reusing the session for cheaper rounds), then **stop at the human
merge gate**. It is explicit-only (`disable-model-invocation`).

## Single source, two portable forms
The canonical skill lives at `skills/wux-review/SKILL.md`. `bun run
skills:generate` emits the two portable host copies — `.claude/skills/wux-review/`
(Claude) and `.agents/skills/wux-review/` (Codex/agents) — and embeds the
content into `src/skills/embedded.ts` so the binary carries it. Regeneration is
a no-op when nothing changed, and a test asserts the copies never drift from the
source.

## Installing the skill
```bash
# from a release (extracts the skill embedded in the binary):
install.sh --with-skills          # installs to $WUX_REVIEW_SKILLS_DIR (default ~/.claude/skills)

# or print it directly:
wux-review skills show wux-review
```

## Handling blocked reviews from agent callers
Agent wrappers should treat exit `2` as a successful review result whose verdict
is `block`, not as a crashed process. This matters for callers running under
`set -e`: capture stdout and the process status before parsing the JSON.

```bash
stdout_file="$(mktemp)"
stderr_file="$(mktemp)"
set +e
wux-review <target> --json >"$stdout_file" 2>"$stderr_file"
status="$?"
set -e

case "$status" in
  0) outcome="review-approved" ;;
  2) outcome="review-blocked" ;;
  *) printf 'wux-review failed with exit %s\n' "$status" >&2; cat "$stderr_file" >&2; exit "$status" ;;
esac

python3 - "$stdout_file" "$outcome" <<'PY'
import json
import sys

with open(sys.argv[1], "r", encoding="utf-8") as handle:
    payload = json.load(handle)
print(json.dumps({"outcome": sys.argv[2], "verdict": payload["verdict"]}))
PY
```

The JSON envelope remains the source of truth on exit `2`; callers should read
`must_fix`, apply the fix outside `wux-review`, and re-review rather than
discarding stdout because the process status is non-zero.
