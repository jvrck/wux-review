import { describe, expect, test } from "bun:test";
import {
  mkdir,
  mkdtemp,
  readdir,
  rm,
  stat,
  utimes,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  acquireObservableRecoveryLock,
  appendPreparedChild,
  appendRoundEvidence,
  createObservableRoundStore,
  sessionStateSha256,
  type ObservableRoundRecord,
  type ObservableRoundStoreDeps,
} from "../../src/review/observable-lifecycle";

function harness(initial: Record<string, string> = {}) {
  const files = new Map(Object.entries(initial));
  const stateDir = "/rounds";
  const renames: [string, string][] = [];
  const deps: ObservableRoundStoreDeps = {
    stateDir,
    readFile: async (path) => files.get(path),
    writeFile: async (path, content) => void files.set(path, content),
    rename: async (from, to) => {
      const content = files.get(from);
      if (content === undefined) throw new Error(`missing ${from}`);
      files.set(to, content);
      files.delete(from);
      renames.push([from, to]);
    },
    mkdir: async () => {},
    rm: async (path) => void files.delete(path),
    removeDir: async () => {},
    list: async () => [...files.keys()]
      .filter((path) => path.startsWith(`${stateDir}/`))
      .map((path) => path.slice(stateDir.length + 1)),
    retentionDays: 7,
  };
  return {
    files,
    renames,
    store: createObservableRoundStore(deps),
  };
}

function record(updatedAt = "2026-07-28T00:00:00.000Z"): ObservableRoundRecord {
  return {
    version: 1,
    reviewId: "round-test",
    round: 1,
    executionId: "exec1",
    sessionMode: false,
    priorStateSha256: null,
    expected: {
      claudeChildName: "round-test-r1-claude",
      codexChildName: "round-test-r1-codex",
    },
    ledger: { claude: [], codex: [] },
    evidence: { claude: [], codex: [] },
    state: "pending",
    startedAt: "2026-07-28T00:00:00.000Z",
    updatedAt,
  };
}

describe("observable round recovery store", () => {
  test("publishes state by tmp-plus-rename and reloads the strict identity", async () => {
    const h = harness();
    await h.store.save(record());
    expect(h.renames).toEqual([
      ["/rounds/round-test.json.tmp", "/rounds/round-test.json"],
    ]);
    expect(h.files.has("/rounds/round-test.json.tmp")).toBe(false);
    await expect(h.store.load("round-test")).resolves.toEqual(record());
  });

  test("finalization journals parser-owned verdicts without re-deriving them", async () => {
    const finalizing: ObservableRoundRecord = {
      ...record(),
      state: "finalizing",
      finalization: {
        sessionStateSha256: null,
        results: {
          claude: {
            reviewer: "claude",
            findings: [{
              lens: "correctness",
              file: "src/example.ts",
              line: 1,
              severity: "must-fix",
              finding: "parser-owned result",
            }],
            verdict: "approve",
          },
          codex: { reviewer: "codex", findings: [], verdict: "approve" },
        },
      },
    };
    const h = harness();
    await h.store.save(finalizing);
    await expect(h.store.load("round-test")).resolves.toEqual(finalizing);
  });

  test("recovers a valid lone tmp record and discards a malformed crash remnant", async () => {
    const valid = record();
    const h = harness({
      "/rounds/round-test.json.tmp": `${JSON.stringify(valid)}\n`,
    });
    await expect(h.store.load("round-test")).resolves.toEqual(valid);
    expect(h.renames).toContainEqual([
      "/rounds/round-test.json.tmp",
      "/rounds/round-test.json",
    ]);

    const malformed = harness({ "/rounds/round-test.json.tmp": "{}\n" });
    await expect(malformed.store.load("round-test")).resolves.toBeUndefined();
    expect(malformed.files.has("/rounds/round-test.json.tmp")).toBe(false);
  });

  test("promotes a valid newer tmp journal over an older main journal", async () => {
    const old = record("2026-07-28T00:00:00.000Z");
    const fresh = appendRoundEvidence(
      old,
      {
        reviewer: "claude",
        childName: "round-test-r1-claude",
        attempt: 1,
        evidencePath: "/evidence/round-test-r1-claude",
        resultPath: "/evidence/round-test-r1-claude/result.json",
        resultId: "fresh-result",
        promptSha256: "a".repeat(64),
        transientBase: "/tmp/wux-review/round-test-r1-claude",
        ownedCleanupKey: "b".repeat(64),
      },
      "2026-07-28T00:00:01.000Z",
    );
    const h = harness({
      "/rounds/round-test.json": `${JSON.stringify(old)}\n`,
      "/rounds/round-test.json.tmp": `${JSON.stringify(fresh)}\n`,
    });
    await expect(h.store.load("round-test")).resolves.toEqual(fresh);
    expect(h.renames).toContainEqual([
      "/rounds/round-test.json.tmp",
      "/rounds/round-test.json",
    ]);
    expect(JSON.parse(h.files.get("/rounds/round-test.json")!))
      .toEqual(fresh);
  });

  test("loads a terminal pre-authentication journal so a later round can replace it", async () => {
    const legacy = {
      ...record(),
      state: "completed" as const,
      evidence: {
        claude: [],
        codex: [{
          reviewer: "codex" as const,
          childName: "round-test-r1-codex",
          attempt: 1,
          evidencePath: "/evidence/round-test-r1-codex",
          resultPath: "/evidence/round-test-r1-codex/result.json",
          resultId: "legacy-result",
          promptSha256: "a".repeat(64),
          transientBase: "/tmp/wux-review/round-test-r1-codex",
        }],
      },
    };
    const h = harness({
      "/rounds/round-test.json": `${JSON.stringify(legacy)}\n`,
    });
    await expect(h.store.load("round-test")).resolves.toMatchObject({
      state: "completed",
      evidence: { codex: [{ resultId: "legacy-result" }] },
    });
  });

  test("keeps the recovery journal private because it contains cleanup capabilities", async () => {
    const dir = await mkdtemp(join(tmpdir(), "wuxr-private-round-"));
    const stateDir = join(dir, "rounds");
    try {
      const store = createObservableRoundStore({ stateDir });
      await store.save(record());
      expect((await stat(stateDir)).mode & 0o777).toBe(0o700);
      expect((await stat(join(stateDir, "round-test.json"))).mode & 0o777)
        .toBe(0o600);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("session hashes are stable across object property order", () => {
    const left = {
      version: 1 as const,
      round: 1,
      results: {
        claude: { reviewer: "claude" as const, findings: [], verdict: "approve" as const },
        codex: { reviewer: "codex" as const, findings: [], verdict: "approve" as const },
      },
      sticky: { claude: [], codex: [] },
    };
    const right = {
      sticky: { codex: [], claude: [] },
      results: {
        codex: { verdict: "approve" as const, findings: [], reviewer: "codex" as const },
        claude: { verdict: "approve" as const, findings: [], reviewer: "claude" as const },
      },
      round: 1,
      version: 1 as const,
    };
    expect(sessionStateSha256(left)).toBe(sessionStateSha256(right));
  });

  test("evidence is exact-attempt bound and moves pending to running", () => {
    const next = appendRoundEvidence(
      record(),
      {
        reviewer: "codex",
        childName: "round-test-r1-codex",
        attempt: 1,
        evidencePath: "/evidence/round-test-r1-codex",
        resultPath: "/evidence/round-test-r1-codex/result.json",
        resultId: "result-1",
        promptSha256: "a".repeat(64),
        transientBase: "/tmp/wux-review/round-test-r1-codex",
        ownedCleanupKey: "b".repeat(64),
      },
      "2026-07-28T00:00:01.000Z",
    );
    expect(next.state).toBe("running");
    expect(next.evidence.codex).toHaveLength(1);
    expect(() => appendRoundEvidence(
      next,
      { ...next.evidence.codex[0]! },
      "2026-07-28T00:00:02.000Z",
    )).toThrow("duplicate or regressed recovery evidence");

    const checkpointed = appendRoundEvidence(
      next,
      {
        ...next.evidence.codex[0]!,
        eventPrefix: {
          bytes: 42,
          sha256: "c".repeat(64),
        },
      },
      "2026-07-28T00:00:02.000Z",
    );
    expect(checkpointed.evidence.codex[0]?.eventPrefix?.bytes).toBe(42);
    const exited = appendRoundEvidence(
      checkpointed,
      {
        ...checkpointed.evidence.codex[0]!,
        wrapperExitedNormally: true,
        eventPrefix: {
          bytes: 84,
          sha256: "d".repeat(64),
        },
      },
      "2026-07-28T00:00:03.000Z",
    );
    expect(exited.evidence.codex[0]?.wrapperExitedNormally).toBe(true);
    expect(() => appendRoundEvidence(
      exited,
      {
        ...exited.evidence.codex[0]!,
        wrapperExitedNormally: undefined,
        eventPrefix: {
          bytes: 126,
          sha256: "e".repeat(64),
        },
      },
      "2026-07-28T00:00:04.000Z",
    )).toThrow("duplicate or regressed recovery evidence");
  });

  test("prepared retry children are exact-attempt bound before evidence", () => {
    const base = record();
    const prepared = appendPreparedChild(
      base,
      "codex",
      `${base.expected.codexChildName}-a2`,
      2,
      "2026-07-28T00:00:01.000Z",
    );
    expect(prepared.prepared).toEqual({
      claude: [base.expected.claudeChildName],
      codex: [base.expected.codexChildName, `${base.expected.codexChildName}-a2`],
    });
    expect(appendPreparedChild(
      prepared,
      "codex",
      `${base.expected.codexChildName}-a2`,
      2,
      "2026-07-28T00:00:02.000Z",
    )).toBe(prepared);
    expect(() => appendPreparedChild(
      prepared,
      "codex",
      `${base.expected.codexChildName}-a3`,
      2,
      "2026-07-28T00:00:02.000Z",
    )).toThrow("cross-leg or stale prepared identity");
    expect(() => appendRoundEvidence(
      {
        ...base,
        prepared: {
          claude: [base.expected.claudeChildName],
          codex: [base.expected.codexChildName],
        },
      },
      {
        reviewer: "codex",
        childName: `${base.expected.codexChildName}-a2`,
        attempt: 2,
        evidencePath: `/evidence/${base.expected.codexChildName}-a2`,
        resultPath: `/evidence/${base.expected.codexChildName}-a2/result.json`,
        resultId: "unprepared-result",
        promptSha256: "a".repeat(64),
        transientBase: `/tmp/wux-review/${base.expected.codexChildName}-a2`,
      },
      "2026-07-28T00:00:02.000Z",
    )).toThrow("recovery evidence was not prepared");
  });

  test("prunes only valid expired records and preserves malformed evidence", async () => {
    const expired = {
      ...record("2026-07-01T00:00:00.000Z"),
      state: "reconciled" as const,
    };
    const interrupted = {
      ...record("2026-07-01T00:00:00.000Z"),
      reviewId: "round-interrupted",
      state: "interrupted" as const,
    };
    const fresh = { ...record("2026-07-27T00:00:00.000Z"), reviewId: "round-fresh" };
    const cleanupPending = {
      ...record("2026-07-01T00:00:00.000Z"),
      reviewId: "round-cleanup-pending",
      state: "failed" as const,
      cleanupPending: true,
    };
    const h = harness({
      "/rounds/round-test.json": `${JSON.stringify(expired)}\n`,
      "/rounds/round-interrupted.json": `${JSON.stringify(interrupted)}\n`,
      "/rounds/round-fresh.json": `${JSON.stringify(fresh)}\n`,
      "/rounds/round-cleanup-pending.json": `${JSON.stringify(cleanupPending)}\n`,
      "/rounds/round-malformed.json": "{",
    });
    await h.store.prune(new Date("2026-07-28T00:00:00.000Z"));
    expect(h.files.has("/rounds/round-test.json")).toBe(false);
    expect(h.files.has("/rounds/round-interrupted.json")).toBe(true);
    expect(h.files.has("/rounds/round-fresh.json")).toBe(true);
    expect(h.files.has("/rounds/round-cleanup-pending.json")).toBe(true);
    expect(h.files.has("/rounds/round-malformed.json")).toBe(true);
  });

  test("serializes reconciliation and releases the exact review lock", async () => {
    const dir = await mkdtemp(join(tmpdir(), "wuxr-round-lock-"));
    try {
      const release = await acquireObservableRecoveryLock("round-test", dir);
      await expect(acquireObservableRecoveryLock("round-test", dir)).rejects.toThrow(
        "another review or reconciliation is already in progress",
      );
      await release();
      const releaseAgain = await acquireObservableRecoveryLock("round-test", dir);
      await releaseAgain();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("does not steal an old-mtime JSON ticket from its live process owner", async () => {
    const dir = await mkdtemp(join(tmpdir(), "wuxr-round-live-lock-"));
    try {
      const lockDir = join(dir, "round-test.locks");
      const release = await acquireObservableRecoveryLock("round-test", dir);
      const [ticket] = await readdir(lockDir);
      expect(ticket).toBeDefined();
      await utimes(join(lockDir, ticket!), new Date(0), new Date(0));
      await expect(acquireObservableRecoveryLock("round-test", dir)).rejects.toThrow(
        "another review or reconciliation is already in progress",
      );
      await release();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("release removes its empty lock directory and prune reaps crash remnants", async () => {
    const dir = await mkdtemp(join(tmpdir(), "wuxr-round-prune-lock-"));
    try {
      const lockDir = join(dir, "round-test.locks");
      const release = await acquireObservableRecoveryLock("round-test", dir);
      await release();
      await expect(stat(lockDir)).rejects.toMatchObject({ code: "ENOENT" });
      await mkdir(lockDir);
      await createObservableRoundStore({
        stateDir: dir,
        retentionDays: 0,
      }).prune();
      await expect(stat(lockDir)).rejects.toMatchObject({ code: "ENOENT" });
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("elects one winner instead of making simultaneous contenders reject each other", async () => {
    const dir = await mkdtemp(join(tmpdir(), "wuxr-round-race-lock-"));
    try {
      const contenders = await Promise.allSettled([
        acquireObservableRecoveryLock("round-test", dir),
        acquireObservableRecoveryLock("round-test", dir),
      ]);
      const winners = contenders.filter(
        (result): result is PromiseFulfilledResult<() => Promise<void>> =>
          result.status === "fulfilled",
      );
      const losers = contenders.filter((result) => result.status === "rejected");
      expect(winners).toHaveLength(1);
      expect(losers).toHaveLength(1);
      await winners[0]!.value();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("reclaims an old empty lock left by a crash during lock initialization", async () => {
    const dir = await mkdtemp(join(tmpdir(), "wuxr-round-empty-lock-"));
    try {
      const lockDir = join(dir, "round-test.locks");
      await mkdir(lockDir);
      const path = join(lockDir, "crashed.lock");
      await writeFile(path, "", { mode: 0o600 });
      await utimes(path, new Date(0), new Date(0));
      const release = await acquireObservableRecoveryLock("round-test", dir);
      await release();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("does not steal an old numeric-PID ticket from its live legacy owner", async () => {
    const dir = await mkdtemp(join(tmpdir(), "wuxr-round-legacy-live-pid-"));
    try {
      const lockDir = join(dir, "round-test.locks");
      await mkdir(lockDir);
      const path = join(lockDir, "crashed.lock");
      await writeFile(path, `${process.pid}\n`, { mode: 0o600 });
      await utimes(path, new Date(0), new Date(0));
      await expect(acquireObservableRecoveryLock("round-test", dir)).rejects.toThrow(
        "another review or reconciliation is already in progress",
      );
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("reclaims an old numeric-PID ticket after its legacy owner exits", async () => {
    const dir = await mkdtemp(join(tmpdir(), "wuxr-round-legacy-dead-pid-"));
    try {
      const lockDir = join(dir, "round-test.locks");
      await mkdir(lockDir);
      const path = join(lockDir, "crashed.lock");
      await writeFile(path, "2147483647\n", { mode: 0o600 });
      await utimes(path, new Date(0), new Date(0));
      const release = await acquireObservableRecoveryLock("round-test", dir);
      await release();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("a process-incarnation mismatch is reclaimed even while its pid is live", async () => {
    const dir = await mkdtemp(join(tmpdir(), "wuxr-round-pid-identity-"));
    try {
      const lockDir = join(dir, "round-test.locks");
      await mkdir(lockDir);
      await writeFile(
        join(lockDir, "crashed.lock"),
        `${JSON.stringify({
          pid: process.pid,
          processIdentity: "not-this-process",
        })}\n`,
        { mode: 0o600 },
      );
      const release = await acquireObservableRecoveryLock("round-test", dir);
      await release();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
