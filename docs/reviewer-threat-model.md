# Reviewer threat model

`wux-review` sends an untrusted diff and the fixed review brief to two model
providers. The reviewer legs are judges only: ambient agent configuration must
not turn either leg into a repository or external-system mutation path.

## Trust boundary

The reviewed repository, the diff, project instructions, and user-configured
agent extensions are untrusted reviewer input. The operator's selected model
provider and its authentication route are trusted dependencies: using the tool
necessarily sends the review prompt and diff to both configured providers.
The model API is therefore **not** a data-isolation boundary, and this design
does not claim that the diff is hidden from Claude, Codex, or their selected
providers.

The boundary is mutation and ambient customization, not host confidentiality.
Codex's read-only sandbox prevents filesystem writes but may allow reads needed
by the CLI. Claude and Codex authentication material remains available to their
respective CLI processes. An administrator-managed Claude policy and an
operator-selected custom provider/auth helper are also outside the untrusted
repository boundary; they must be governed as host administration and provider
configuration, not as project configuration.

## Threats and controls

| Threat | Claude leg | Codex leg |
|---|---|---|
| Project instructions/settings | Runs in a fresh mode-0700 per-leg directory, never the reviewed repository or a shared temp path; `--safe-mode` disables `CLAUDE.md` and project customizations. | Runs and uses `-C` in a fresh mode-0700 per-leg directory, never the reviewed repository or a shared temp path. This prevents discovery of project `AGENTS.md` and trusted-repository `.codex/config.toml`; the isolated home contains no global `AGENTS.md`, and `--ignore-rules` disables ambient exec-policy rules. |
| User settings and instructions | `--safe-mode` disables user customizations and `--settings {}` supplies no worker customization. | A fresh mode-0700 `CODEX_HOME` receives scalar allowlisted fields plus preserved provider tables from sanitized config layers, never the user's files wholesale. Instructions, project trust, permissions, and feature toggles are removed. |
| Hooks, plugins, and skills | `--safe-mode` disables hooks/plugins and `--disable-slash-commands` disables skills. | `notify`, `hooks`, `plugins`, `marketplaces`, `skills`, `features`, and tool configuration are absent from the sanitized config and plugin/cache directories are not copied. |
| Built-in tools and repository writes | `--tools ""` exposes no built-in tools. | `-s read-only` mechanically rejects filesystem mutation; the target repository is not the working root. |
| MCP and external mutation | `--strict-mcp-config` with no `--mcp-config` rejects ambient MCP definitions; no tools are exposed. | `mcp_servers` is removed and no plugin or custom-tool configuration is copied. This prevents ambient extensions from supplying external mutation tools; it is not a general network or provider boundary. |
| Session persistence | `--no-session-persistence` prevents the print session being saved. | `--ephemeral` prevents session persistence; all remaining writable CLI state lives in the throwaway home. |
| Authentication | `--bare` is deliberately not used because Claude 2.1.226 says it disables OAuth/keychain reads. Safe mode leaves OAuth/keychain and `ANTHROPIC_API_KEY` authentication working. | `auth.json` is copied, mode 0600, into the throwaway home. Built-in auth variables and the `env_key` declared by a preserved custom provider remain inherited for API/batch deployments. Creating, seeding, or sanitizing the isolated home fails closed and never falls back to the user's home. Auth-route detection is separate and advisory: when no credential route is detectable, the leg warns and proceeds so unauthenticated local/OSS providers work and Codex itself reports any genuine authentication error. |
| Provider/model selection | An explicit `--model` is unchanged; safe mode leaves model selection normal. | Codex 0.147.0's scalar routing/model controls survive the allowlist, including `model`, `review_model`, `model_provider`, context/compaction settings, reasoning effort/summary, verbosity, service tier, `chatgpt_base_url`, `openai_base_url`, and `oss_provider`. Provider tables, legacy profiles declared in `config.toml`, and separately sanitized `<name>.config.toml` profile layers—including symlink-managed layers whose resolved targets are bounded regular files—survive. Non-regular or oversized layers are skipped diagnostically during setup. Explicit `-m` remains unchanged. |

Both direct and observable transports receive the same contained reviewer argv,
private per-leg cwd, environment, prompt bytes, parsing, and verdict contract. Observable
mode changes only how that invocation is supervised and recorded.

## Verification

The adversarial fixtures under `test/fixtures/reviewer-isolation/` combine
malicious project instructions, Claude hooks/plugins/MCP settings, Codex
hooks/plugins/skills/MCP/notify settings, and prompt injection inside a diff. A
real fake-reviewer process records any reachable invocation path and attempts a
repository overwrite when a write/tool surface is present. The backend tests
require zero markers, an unchanged repository sentinel, a sanitized Codex config,
and byte-identical contained argv between direct and observable transports.

These tests prove the launch mechanics and configuration boundary. They do not
prove that a model will ignore malicious prose; safety does not depend on that.
