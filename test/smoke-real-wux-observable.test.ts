import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const REPO_ROOT = new URL("..", import.meta.url).pathname;
const smoke = readFileSync(join(REPO_ROOT, "scripts/smoke-real-wux-observable.sh"), "utf8");
const workflow = readFileSync(join(REPO_ROOT, ".github/workflows/e2e.yml"), "utf8");

test("real-Wux smoke cleanup survives diagnostics collection failure", () => {
  expect(smoke).toContain('collect_diagnostics "$status" || true');
});

test("CI pins the released Wux fixture and gives the smoke its absolute path", () => {
  expect(workflow).toContain("WUX_VERSION: 2026.08.17");
  expect(workflow).toContain("WUX_OWNER_CONTRACT_VERSION: 2026.08.17");
  expect(workflow).toContain("WUX_REAL_SMOKE_WUX_BIN: ${{ runner.temp }}/wux-owner-contract-bin/wux");
  expect(workflow).toContain("WUX_REAL_SMOKE_WUX_VERSION: 2026.08.17");
});

test("fake Codex retains its unreadable-brief diagnostic after missing prompt extraction", () => {
  expect(smoke).toContain('grep -oE \'/[^ ]*-prompt\\.md\' | head -1 || true');
  expect(smoke).toContain("fake codex: unreadable brief");
});

test("visibility polling retries a transient Wux status failure until its deadline", () => {
  expect(smoke).toContain('if ! status="$(PATH="$smoke_path" wux --local status --json)"; then');
  expect(smoke).toContain("deadline=$((SECONDS + 5))");
});

test("visibility fakes remain alive long enough for slow schedulers", () => {
  expect(smoke).toContain('WUXR_REAL_SMOKE_DELAY_SECONDS:-5');
  expect(smoke).toContain('start_review "$interrupt_session" APPROVE_CASE interrupted 8');
});

test("smoke uses a descriptive dependency-loop variable and reports pin drift as skip", () => {
  expect(smoke).toContain("for required_command in git jq tmux; do");
  expect(smoke).toContain("SKIP: expected Wux");
});
