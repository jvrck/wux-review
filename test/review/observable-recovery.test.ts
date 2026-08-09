import { describe, expect, test } from "bun:test";
import { createHash, createHmac } from "node:crypto";
import { tmpdir } from "node:os";
import type { HeadlessRunOptions } from "../../src/backends/headless";
import { reconcileReview } from "../../src/review/observable-recovery";
import type {
  ObservableRoundRecord,
  ObservableRoundStore,
} from "../../src/review/observable-lifecycle";
import type { SessionStore } from "../../src/review/session-state";
import type { LegExecutionEvidence, SessionState } from "../../src/review/types";

const REPORT = '```json\n{"findings":[]}\n```';
const CLAUDE_STREAM = JSON.stringify({
  type: "result",
  subtype: "success",
  is_error: false,
  result: REPORT,
});

function recoveryHarness(options: {
  taintReviewer?: "claude" | "codex";
  priorOwnedCleanupReviewer?: "claude" | "codex";
  repeatedOwnedCleanupReviewer?: "claude" | "codex";
  idempotentStopSuccessReviewer?: "claude" | "codex";
  externalStopRaceReviewer?: "claude" | "codex";
  stopSuccessWithoutEventReviewer?: "claude" | "codex";
  wrapperExitProofReviewer?: "claude" | "codex";
  forgedOwnedCleanupReviewer?: "claude" | "codex";
  codexRetry?: boolean;
  liveReviewer?: "claude" | "codex";
  liveChildName?: string;
  sessionSaveFailures?: number;
  reconciledRoundSaveFailures?: number;
  transientCleanupFailures?: number;
  mutateRecord?: (record: ObservableRoundRecord) => void;
  prior?: SessionState;
} = {}) {
  const reviewId = "recover-review";
  const files = new Map<string, string>();
  const calls: { cmd: string[]; opts: HeadlessRunOptions }[] = [];
  const savedSessions = new Map<string, SessionState>();
  let sessionSaveFailures = options.sessionSaveFailures ?? 0;
  let reconciledRoundSaveFailures =
    options.reconciledRoundSaveFailures ?? 0;
  let transientCleanupFailures = options.transientCleanupFailures ?? 0;
  if (options.prior !== undefined) savedSessions.set(reviewId, options.prior);
  const evidence = {
    claude: makeEvidence("claude", reviewId),
    codex: makeEvidence("codex", reviewId),
  };
  const codexRetry = options.codexRetry
    ? {
        ...makeEvidence("codex", reviewId),
        childName: `${evidence.codex.childName}-a2`,
        attempt: 2,
        evidencePath: `${evidence.codex.evidencePath}-a2`,
        resultPath: `${evidence.codex.evidencePath}-a2/result.json`,
        resultId: "result-codex-2",
        ownedCleanupKey: "c".repeat(64),
        transientBase: `${evidence.codex.transientBase}-a2`,
      }
    : undefined;
  const liveChildren = new Set<string>();
  if (options.liveReviewer !== undefined) {
    liveChildren.add(evidence[options.liveReviewer].childName);
  }
  if (options.liveChildName !== undefined) {
    liveChildren.add(options.liveChildName);
  }
  for (const record of [
    evidence.claude,
    evidence.codex,
    ...(codexRetry === undefined ? [] : [codexRetry]),
  ]) {
    const identity = {
      id: record.resultId,
      reviewId,
      round: 1,
      reviewer: record.reviewer,
      childName: record.childName,
      attempt: record.attempt,
      promptSha256: record.promptSha256,
    };
    const events = [
      { type: "create", at: "2026-07-28T00:00:00Z", run: record.childName },
      ...(options.taintReviewer === record.reviewer
        ? [{
            type: "send",
            at: "2026-07-28T00:00:01Z",
            run: record.childName,
            by: "external@host",
          }]
        : []),
      ...(options.priorOwnedCleanupReviewer === record.reviewer
        ? [
            {
              type: "stop",
              at: "2026-07-28T00:00:01Z",
              run: record.childName,
              by: "worker@host",
            },
            {
              type: "review-leg-owned-cleanup",
              at: "2026-07-28T00:00:01Z",
              run: record.childName,
              resultId: record.resultId,
              stopAt: "2026-07-28T00:00:01Z",
              stopBy: "worker@host",
              proof: cleanupProof(
                record,
                "2026-07-28T00:00:01Z",
                "worker@host",
              ),
            },
          ]
        : []),
      ...(options.repeatedOwnedCleanupReviewer === record.reviewer
        ? [
            {
              type: "stop",
              at: "2026-07-28T00:00:01Z",
              run: record.childName,
              by: "worker@host",
            },
            {
              type: "review-leg-owned-cleanup",
              at: "2026-07-28T00:00:01Z",
              run: record.childName,
              resultId: record.resultId,
              stopAt: "2026-07-28T00:00:01Z",
              stopBy: "worker@host",
              proof: cleanupProof(
                record,
                "2026-07-28T00:00:01Z",
                "worker@host",
              ),
            },
            {
              type: "stop",
              at: "2026-07-28T00:00:02Z",
              run: record.childName,
              by: "worker@host",
            },
            {
              type: "review-leg-owned-cleanup",
              at: "2026-07-28T00:00:02Z",
              run: record.childName,
              resultId: record.resultId,
              stopAt: "2026-07-28T00:00:02Z",
              stopBy: "worker@host",
              proof: cleanupProof(
                record,
                "2026-07-28T00:00:02Z",
                "worker@host",
              ),
            },
          ]
        : []),
      ...(options.forgedOwnedCleanupReviewer === record.reviewer
        ? [
            {
              type: "stop",
              at: "2026-07-28T00:00:01Z",
              run: record.childName,
              by: "external@host",
            },
            {
              type: "review-leg-owned-cleanup",
              at: "2026-07-28T00:00:01Z",
              run: record.childName,
              resultId: record.resultId,
              stopAt: "2026-07-28T00:00:01Z",
              stopBy: "external@host",
              proof: "0".repeat(64),
            },
          ]
        : []),
    ];
    const rawEvents = `${events.map((event) => JSON.stringify(event)).join("\n")}\n`;
    files.set(`${record.evidencePath}/events.jsonl`, rawEvents);
    record.eventPrefix = {
      bytes: Buffer.byteLength(rawEvents),
      sha256: createHash("sha256").update(rawEvents).digest("hex"),
    };
    if (options.wrapperExitProofReviewer === record.reviewer) {
      record.wrapperExitedNormally = true;
    }
    files.set(`${record.evidencePath}/prompt.md`, `PROMPT-${record.reviewer}`);
    files.set(
      `${record.evidencePath}/lifecycle.json`,
      `${JSON.stringify({
        version: 1,
        identity,
        state: "interrupted",
        startedAt: "2026-07-28T00:00:00Z",
        updatedAt: "2026-07-28T00:00:01Z",
      })}\n`,
    );
    files.set(
      `${record.evidencePath}/status.json`,
      `${JSON.stringify({
        version: 2,
        reviewId,
        round: 1,
        reviewer: record.reviewer,
        attempt: record.attempt,
        childName: record.childName,
        status: "interrupted",
        startedAt: "2026-07-28T00:00:00Z",
        updatedAt: "2026-07-28T00:00:01Z",
        lastActivityAt: "2026-07-28T00:00:01Z",
        phase: "interrupted",
        latestActivity: "parent interrupted",
        result: {
          state: "pending",
          code: null,
          timedOut: false,
          resultId: record.resultId,
        },
        diagnostics: { malformed: 0, oversized: 0, unknown: 0, renderer: 0 },
      })}\n`,
    );
    files.set(`${record.transientBase}-observable-done`, "0");
    files.set(`${record.transientBase}-observable-stderr`, "");
    files.set(
      `${record.transientBase}-observable-stdout`,
      record.reviewer === "claude"
        ? CLAUDE_STREAM
        : `${JSON.stringify({ type: "turn.completed" })}\n`,
    );
    if (record.reviewer === "codex") {
      files.set(`${record.transientBase}-observable-output`, REPORT);
    }
  }
  if (codexRetry !== undefined) {
    const identity = {
      id: evidence.codex.resultId,
      reviewId,
      round: 1,
      reviewer: "codex",
      childName: evidence.codex.childName,
      attempt: 1,
      promptSha256: evidence.codex.promptSha256,
    };
    files.set(
      evidence.codex.resultPath,
      `${JSON.stringify({
        version: 1,
        identity,
        process: { code: 1, stdout: "", stderr: "retryable", timedOut: false },
        output: REPORT,
      })}\n`,
    );
    files.set(
      `${evidence.codex.evidencePath}/lifecycle.json`,
      `${JSON.stringify({
        version: 1,
        identity,
        state: "failed",
        startedAt: "2026-07-28T00:00:00Z",
        updatedAt: "2026-07-28T00:00:01Z",
        diagnostic: "reviewer process exited 1",
      })}\n`,
    );
  }

  let round: ObservableRoundRecord = {
    version: 1,
    reviewId,
    round: 1,
    executionId: "exec1",
    sessionMode: true,
    priorStateSha256: null,
    expected: {
      claudeChildName: evidence.claude.childName,
      codexChildName: evidence.codex.childName,
    },
    ledger: { claude: [], codex: [] },
    evidence: {
      claude: [evidence.claude],
      codex: [
        evidence.codex,
        ...(codexRetry === undefined ? [] : [codexRetry]),
      ],
    },
    state: "interrupted",
    startedAt: "2026-07-28T00:00:00Z",
    updatedAt: "2026-07-28T00:00:01Z",
  };
  options.mutateRecord?.(round);
  const roundStore: ObservableRoundStore = {
    async load(id) {
      return id === reviewId ? structuredClone(round) : undefined;
    },
    async save(next) {
      if (next.state === "reconciled" && reconciledRoundSaveFailures > 0) {
        reconciledRoundSaveFailures--;
        throw new Error("round journal ENOSPC");
      }
      round = structuredClone(next);
    },
    async clear() {},
    async prune() {},
  };
  const sessionStore: SessionStore = {
    async load(id) {
      return savedSessions.get(id);
    },
    async save(id, state) {
      if (sessionSaveFailures > 0) {
        sessionSaveFailures--;
        throw new Error("ENOSPC");
      }
      savedSessions.set(id, structuredClone(state));
    },
    async clear(id) {
      savedSessions.delete(id);
    },
  };
  const run = async (cmd: string[], opts: HeadlessRunOptions) => {
    calls.push({ cmd, opts });
    if (cmd.includes("status")) {
      return {
        code: 0,
        stdout: JSON.stringify(
          [...liveChildren].map((name) => ({ name, status: "running" })),
        ),
        stderr: "",
        timedOut: false,
      };
    }
    if (cmd.includes("read")) {
      const childName = cmd[cmd.indexOf("read") + 1]!;
      if (liveChildren.has(childName)) {
        return {
          code: 0,
          stdout: JSON.stringify({
            name: childName,
            runDir: `/evidence/${childName}`,
            lines: [],
          }),
          stderr: "",
          timedOut: false,
        };
      }
      return {
        code: 1,
        stdout: "",
        stderr: "tmux session is not running",
        timedOut: false,
      };
    }
    if (cmd.includes("stop")) {
      const childName = cmd[cmd.indexOf("stop") + 1]!;
      liveChildren.delete(childName);
      const path = `/evidence/${childName}/events.jsonl`;
      const reviewer = childName.startsWith(evidence.codex.childName)
        ? "codex"
        : "claude";
      if (options.stopSuccessWithoutEventReviewer === reviewer) {
        return { code: 0, stdout: "", stderr: "", timedOut: false };
      }
      if (options.externalStopRaceReviewer === reviewer) {
        files.set(
          path,
          `${files.get(path) ?? ""}${JSON.stringify({
            type: "stop",
            at: "2026-07-28T00:00:02Z",
            run: childName,
            by: "external@host",
          })}\n`,
        );
        return { code: 0, stdout: "", stderr: "", timedOut: false };
      }
      if ((files.get(path) ?? "").includes('"review-leg-owned-cleanup"')) {
        return {
          code: options.idempotentStopSuccessReviewer === reviewer ? 0 : 1,
          stdout: "",
          stderr: options.idempotentStopSuccessReviewer === reviewer
            ? ""
            : "wux: run is already stopped",
          timedOut: false,
        };
      }
      files.set(
        path,
        `${files.get(path) ?? ""}${JSON.stringify({
          type: "stop",
          at: "2026-07-28T00:00:03Z",
          run: childName,
          by: opts.env?.USER === undefined
            ? "worker@host"
            : `${opts.env.USER}@host`,
        })}\n`,
      );
      return { code: 0, stdout: "", stderr: "", timedOut: false };
    }
    throw new Error(`model/unknown runner call during reconciliation: ${cmd.join(" ")}`);
  };
  const observable = {
    tmpDir: "/tmp/recovery",
    mkdir: async () => {},
    rm: async (path: string) => {
      if (
        transientCleanupFailures > 0
        && path.endsWith("-observable-args")
      ) {
        transientCleanupFailures--;
        throw new Error("EPERM removing recovery bootstrap");
      }
      files.delete(path);
    },
    writeFile: async (path: string, content: string) => void files.set(path, content),
    writePrivateFile: async (path: string, content: string) => {
      if (files.has(path)) throw new Error("exclusive collision");
      files.set(path, content);
    },
    readFile: async (path: string) => files.get(path),
    snapshotSize: async (path: string) => {
      const raw = files.get(path);
      return raw === undefined ? undefined : Buffer.byteLength(raw);
    },
    readChunk: async (path: string, offset: number, maxBytes: number) =>
      Buffer.from(files.get(path) ?? "").subarray(offset, offset + maxBytes),
    appendFile: async (path: string, content: string) =>
      void files.set(path, `${files.get(path) ?? ""}${content}`),
    rename: async (from: string, to: string) => {
      const raw = files.get(from);
      if (raw === undefined) throw new Error(`missing ${from}`);
      files.set(to, raw);
      files.delete(from);
    },
    sleep: async () => {},
    now: () => "2026-07-28T00:00:02Z",
    resultId: () => "unused",
    cleanupKey: () => "f".repeat(64),
    pollIntervalMs: 1,
  };
  return {
    reviewId,
    evidence,
    codexRetry,
    files,
    calls,
    roundStore,
    sessionStore,
    savedSessions,
    run,
    observable,
    setReviewerLive(reviewer: "claude" | "codex", live: boolean) {
      const childName = evidence[reviewer].childName;
      if (live) liveChildren.add(childName);
      else liveChildren.delete(childName);
    },
    setChildLive(childName: string, live: boolean) {
      if (live) liveChildren.add(childName);
      else liveChildren.delete(childName);
    },
    get round() {
      return round;
    },
  };
}

describe("observable parent recovery", () => {
  test("reconciles two complete untainted legs with zero model calls and cleans transients", async () => {
    const h = recoveryHarness();
    let lockHeld = false;
    const envelope = await reconcileReview(h.reviewId, {
      roundStore: h.roundStore,
      sessionStore: h.sessionStore,
      run: h.run,
      observable: h.observable,
      acquireObservableLock: async (reviewId) => {
        expect(reviewId).toBe(h.reviewId);
        expect(lockHeld).toBe(false);
        lockHeld = true;
        return async () => {
          expect(lockHeld).toBe(true);
          lockHeld = false;
        };
      },
    });
    expect(lockHeld).toBe(false);
    if ("kind" in envelope) {
      throw new Error("expected a recovered review verdict");
    }
    expect(envelope.verdict).toBe("approve");
    expect(envelope.round).toBe(1);
    expect(h.calls.length).toBeGreaterThan(0);
    expect(h.calls.every((call) => call.cmd[0] === "wux")).toBe(true);
    expect(h.calls.some((call) => call.cmd[0] === "claude" || call.cmd[0] === "codex"))
      .toBe(false);
    expect(h.round.state).toBe("reconciled");
    expect(h.savedSessions.get(h.reviewId)?.children?.[0]).toMatchObject({
      round: 1,
      claude: [{ childName: h.evidence.claude.childName }],
      codex: [{ childName: h.evidence.codex.childName }],
    });
    expect(h.savedSessions.get(h.reviewId)?.children?.[0]?.claude[0])
      .not.toHaveProperty("ownedCleanupKey");
    expect(h.savedSessions.get(h.reviewId)?.children?.[0]?.codex[0])
      .not.toHaveProperty("eventPrefix");
    expect(h.savedSessions.get(h.reviewId)?.children?.[0]?.codex[0])
      .not.toHaveProperty("wrapperExitedNormally");
    for (const evidence of [h.evidence.claude, h.evidence.codex]) {
      expect(JSON.parse(h.files.get(`${evidence.evidencePath}/result.json`)!).identity)
        .toMatchObject({ childName: evidence.childName, reviewer: evidence.reviewer });
      expect(JSON.parse(h.files.get(`${evidence.evidencePath}/lifecycle.json`)!).state)
        .toBe("reconciled");
      expect(h.files.has(`${evidence.transientBase}-observable-done`)).toBe(false);
    }
  });

  test("retries a round after one finished leg was reconciled before its sibling exited", async () => {
    const h = recoveryHarness({ liveReviewer: "codex" });
    await expect(reconcileReview(h.reviewId, {
      roundStore: h.roundStore,
      sessionStore: h.sessionStore,
      run: h.run,
      observable: h.observable,
    })).rejects.toThrow("is still running");
    expect(h.round.state).toBe("interrupted");
    expect(h.files.has(`${h.evidence.codex.transientBase}-observable-done`))
      .toBe(true);
    expect(h.calls.some(({ cmd }) =>
      cmd.join(" ") === `wux --local stop ${h.evidence.codex.childName} --yes`
    )).toBe(false);
    expect(JSON.parse(
      h.files.get(`${h.evidence.claude.evidencePath}/lifecycle.json`)!,
    ).state).toBe("reconciled");

    h.setReviewerLive("codex", false);
    await expect(reconcileReview(h.reviewId, {
      roundStore: h.roundStore,
      sessionStore: h.sessionStore,
      run: h.run,
      observable: h.observable,
    })).resolves.toMatchObject({ verdict: "approve" });
    expect(h.round.state).toBe("reconciled");
  });

  test("preserves validated evidence when strict session persistence fails transiently", async () => {
    const h = recoveryHarness({ sessionSaveFailures: 1 });
    await expect(reconcileReview(h.reviewId, {
      roundStore: h.roundStore,
      sessionStore: h.sessionStore,
      run: h.run,
      observable: h.observable,
    })).rejects.toThrow("validated evidence could not be finalized");
    expect(h.round.state).toBe("interrupted");
    expect(h.savedSessions.has(h.reviewId)).toBe(false);
    for (const evidence of [h.evidence.claude, h.evidence.codex]) {
      expect(h.files.has(evidence.resultPath)).toBe(true);
    }

    await expect(reconcileReview(h.reviewId, {
      roundStore: h.roundStore,
      sessionStore: h.sessionStore,
      run: h.run,
      observable: h.observable,
    })).resolves.toMatchObject({ verdict: "approve" });
    expect(h.round.state).toBe("reconciled");
  });

  test("recovers when the session commit succeeds but the reconciled journal write fails", async () => {
    const h = recoveryHarness({ reconciledRoundSaveFailures: 1 });
    await expect(reconcileReview(h.reviewId, {
      roundStore: h.roundStore,
      sessionStore: h.sessionStore,
      run: h.run,
      observable: h.observable,
    })).rejects.toThrow("validated evidence could not be finalized");
    expect(h.round.state).toBe("interrupted");
    expect(h.round.finalization).toBeDefined();
    expect(h.savedSessions.get(h.reviewId)?.round).toBe(1);
    const callsBeforeRetry = h.calls.length;

    await expect(reconcileReview(h.reviewId, {
      roundStore: h.roundStore,
      sessionStore: h.sessionStore,
      run: h.run,
      observable: h.observable,
    })).resolves.toMatchObject({ verdict: "approve", round: 1 });
    expect(h.round.state).toBe("reconciled");
    expect(h.calls).toHaveLength(callsBeforeRetry);
  });

  test("revalidates one-shot finalizing evidence instead of treating null as a commit marker", async () => {
    const h = recoveryHarness({
      mutateRecord: (record) => {
        record.sessionMode = false;
        record.state = "finalizing";
        record.finalization = {
          sessionStateSha256: null,
          results: {
            claude: { reviewer: "claude", findings: [], verdict: "approve" },
            codex: { reviewer: "codex", findings: [], verdict: "approve" },
          },
        };
      },
    });
    await expect(reconcileReview(h.reviewId, {
      roundStore: h.roundStore,
      sessionStore: h.sessionStore,
      run: h.run,
      observable: h.observable,
    })).resolves.toMatchObject({ verdict: "approve", round: 1 });
    expect(h.calls.length).toBeGreaterThan(0);
    expect(h.round.state).toBe("reconciled");
  });

  test("rejects an already completed one-shot round instead of replaying its verdict", async () => {
    const h = recoveryHarness({
      mutateRecord: (record) => {
        record.state = "completed";
      },
    });
    await expect(reconcileReview(h.reviewId, {
      roundStore: h.roundStore,
      sessionStore: h.sessionStore,
      run: h.run,
      observable: h.observable,
    })).rejects.toThrow("already completed and cannot be replayed");
    expect(h.calls).toHaveLength(0);
  });

  test("terminalizes and cleans an incomplete pending round so a new run is not deadlocked", async () => {
    const h = recoveryHarness({
      mutateRecord: (record) => {
        record.state = "pending";
        record.evidence.codex = [];
      },
    });
    await expect(reconcileReview(h.reviewId, {
      roundStore: h.roundStore,
      sessionStore: h.sessionStore,
      run: h.run,
      observable: h.observable,
    })).rejects.toThrow("Codex recovery evidence is incomplete");
    expect(h.round.state).toBe("failed");
    expect(h.calls.every((call) => call.cmd[0] === "wux")).toBe(true);
  });

  test("a terminal cleanup failure stays retryable until retained evidence is reclaimed", async () => {
    const h = recoveryHarness({
      transientCleanupFailures: 1,
      mutateRecord: (record) => {
        record.state = "pending";
        record.evidence.codex = [];
      },
    });
    for (const entry of [h.evidence.claude, h.evidence.codex]) {
      h.files.set(`${entry.transientBase}-observable-args`, "retained bootstrap");
    }
    await expect(reconcileReview(h.reviewId, {
      roundStore: h.roundStore,
      sessionStore: h.sessionStore,
      run: h.run,
      observable: h.observable,
    })).rejects.toThrow("terminal cleanup failed");
    expect(h.round).toMatchObject({ state: "failed", cleanupPending: true });
    const retainedArgs = [h.evidence.claude, h.evidence.codex].filter((entry) =>
      h.files.has(`${entry.transientBase}-observable-args`)
    );
    expect(retainedArgs.length).toBeGreaterThan(0);

    await expect(reconcileReview(h.reviewId, {
      roundStore: h.roundStore,
      sessionStore: h.sessionStore,
      run: h.run,
      observable: h.observable,
    })).resolves.toMatchObject({
      kind: "terminal-cleanup-completed",
      reviewId: h.reviewId,
      state: "failed",
    });
    expect(h.round).toMatchObject({ state: "failed", cleanupPending: false });
    for (const entry of [h.evidence.claude, h.evidence.codex]) {
      expect(h.files.has(`${entry.transientBase}-observable-args`)).toBe(false);
    }
  });

  test("terminal cleanup reclaims readable pre-authentication journals", async () => {
    const h = recoveryHarness({
      mutateRecord: (record) => {
        record.state = "failed";
        record.cleanupPending = true;
        record.diagnostic = "legacy terminal cleanup pending";
        for (const evidence of [
          ...record.evidence.claude,
          ...record.evidence.codex,
        ]) {
          delete evidence.ownedCleanupKey;
        }
      },
    });
    await expect(reconcileReview(h.reviewId, {
      roundStore: h.roundStore,
      sessionStore: h.sessionStore,
      run: h.run,
      observable: h.observable,
    })).resolves.toMatchObject({
      kind: "terminal-cleanup-completed",
      reviewId: h.reviewId,
      state: "failed",
    });
    expect(h.round).toMatchObject({ state: "failed", cleanupPending: false });
    for (const evidence of [h.evidence.claude, h.evidence.codex]) {
      expect(h.files.has(`${evidence.transientBase}-observable-args`))
        .toBe(false);
    }
  });

  test("stops prepared children that crashed before their first evidence checkpoint", async () => {
    const h = recoveryHarness({
      mutateRecord: (record) => {
        record.state = "pending";
        record.evidence = { claude: [], codex: [] };
      },
    });
    const preparedPaths = [
      `${h.evidence.claude.transientBase}-observable-args`,
      `${h.evidence.codex.transientBase}-prompt.md`,
    ];
    const preparedOutput = "/tmp/recovery/prepared-codex-output.txt";
    const preparedHome = `${tmpdir()}/wuxr-codex-home-prepared-recovery`;
    h.files.set(
      `${h.evidence.codex.transientBase}-observable-prepared-cleanup.json`,
      `${JSON.stringify({
        version: 1,
        childName: h.evidence.codex.childName,
        cleanupFiles: [preparedOutput],
        cleanupDir: preparedHome,
      })}\n`,
    );
    preparedPaths.push(preparedOutput, preparedHome);
    for (const path of preparedPaths) h.files.set(path, "prepared transient");
    const calls: string[][] = [];
    await expect(reconcileReview(h.reviewId, {
      roundStore: h.roundStore,
      sessionStore: h.sessionStore,
      acquireObservableLock: async () => async () => {},
      run: async (cmd) => {
        calls.push(cmd);
        if (cmd.includes("status")) {
          return {
            code: 0,
            stdout: "[]",
            stderr: "",
            timedOut: false,
          };
        }
        return {
          code: 1,
          stdout: "",
          stderr: "wux: run is not running",
          timedOut: false,
        };
      },
      observable: h.observable,
    })).rejects.toThrow("Claude recovery requires exactly one attempt");
    const stopped = calls
      .filter((cmd) => cmd.includes("stop"))
      .map((cmd) => cmd[cmd.indexOf("stop") + 1]);
    expect(stopped).toEqual([
      h.evidence.claude.childName,
      h.evidence.codex.childName,
    ]);
    for (const path of preparedPaths) expect(h.files.has(path)).toBe(false);
    expect(h.round.state).toBe("failed");
  });

  test("stops a durably prepared Codex retry that crashed before evidence discovery", async () => {
    let retryChild = "";
    const h = recoveryHarness({
      mutateRecord: (record) => {
        retryChild = `${record.expected.codexChildName}-a2`;
        record.state = "running";
        record.evidence.claude = [];
        record.prepared = {
          claude: [record.expected.claudeChildName],
          codex: [record.expected.codexChildName, retryChild],
        };
      },
    });
    h.setChildLive(retryChild, true);
    const retryBase = `/tmp/recovery/${retryChild}`;
    const retryOutput = "/tmp/recovery/retry-output.txt";
    const sharedPrompt = `/tmp/recovery/${h.evidence.codex.childName}-prompt.md`;
    h.files.set(`${retryBase}-observable-args`, "retry args");
    h.files.set(sharedPrompt, "retry prompt");
    h.files.set(
      `${retryBase}-observable-prepared-cleanup.json`,
      `${JSON.stringify({
        version: 1,
        childName: retryChild,
        cleanupFiles: [retryOutput, sharedPrompt],
      })}\n`,
    );
    h.files.set(retryOutput, "retry output");

    await expect(reconcileReview(h.reviewId, {
      roundStore: h.roundStore,
      sessionStore: h.sessionStore,
      acquireObservableLock: async () => async () => {},
      run: h.run,
      observable: h.observable,
    })).rejects.toThrow("Claude recovery requires exactly one attempt");
    expect(h.calls.some(({ cmd }) =>
      cmd.join(" ") === `wux --local stop ${retryChild} --yes`)).toBe(true);
    expect(h.files.has(`${retryBase}-observable-args`)).toBe(false);
    expect(h.files.has(sharedPrompt)).toBe(false);
    expect(h.files.has(retryOutput)).toBe(false);
    expect(h.round.state).toBe("failed");
  });

  test("tainted evidence can never be reconciled even when both reports approve", async () => {
    const h = recoveryHarness({ taintReviewer: "codex" });
    await expect(reconcileReview(h.reviewId, {
      roundStore: h.roundStore,
      sessionStore: h.sessionStore,
      run: h.run,
      observable: h.observable,
    })).rejects.toThrow("tainted by external send from external@host");
    expect(h.round.state).toBe("tainted");
    expect(h.savedSessions.has(h.reviewId)).toBe(false);
  });

  test("a durable prior owned-cleanup marker does not misclassify wux-review's stop as taint", async () => {
    const h = recoveryHarness({ priorOwnedCleanupReviewer: "codex" });
    await expect(reconcileReview(h.reviewId, {
      roundStore: h.roundStore,
      sessionStore: h.sessionStore,
      run: h.run,
      observable: h.observable,
    })).resolves.toMatchObject({ verdict: "approve" });
    expect(h.round.state).toBe("reconciled");
  });

  test("repeated authenticated owned-cleanup markers remain idempotent", async () => {
    const h = recoveryHarness({ repeatedOwnedCleanupReviewer: "codex" });
    await expect(reconcileReview(h.reviewId, {
      roundStore: h.roundStore,
      sessionStore: h.sessionStore,
      run: h.run,
      observable: h.observable,
    })).resolves.toMatchObject({ verdict: "approve" });
    expect(h.round.state).toBe("reconciled");
  });

  test("an idempotent successful stop trusts a prior authenticated owned event", async () => {
    const h = recoveryHarness({
      priorOwnedCleanupReviewer: "codex",
      idempotentStopSuccessReviewer: "codex",
    });
    await expect(reconcileReview(h.reviewId, {
      roundStore: h.roundStore,
      sessionStore: h.sessionStore,
      run: h.run,
      observable: h.observable,
    })).resolves.toMatchObject({ verdict: "approve" });
    expect(h.round.state).toBe("reconciled");
  });

  test("persisted normal wrapper exit proof survives a crash before round finalization", async () => {
    const h = recoveryHarness({
      stopSuccessWithoutEventReviewer: "codex",
      wrapperExitProofReviewer: "codex",
    });
    await expect(reconcileReview(h.reviewId, {
      roundStore: h.roundStore,
      sessionStore: h.sessionStore,
      run: h.run,
      observable: h.observable,
    })).resolves.toMatchObject({ verdict: "approve" });
    expect(h.round.state).toBe("reconciled");
  });

  test("cleanup-pending taint converges after an operator already stopped the child", async () => {
    const h = recoveryHarness({
      forgedOwnedCleanupReviewer: "codex",
      mutateRecord: (record) => {
        record.state = "tainted";
        record.cleanupPending = true;
        record.diagnostic = "external stop retained for terminal cleanup";
      },
    });
    await expect(reconcileReview(h.reviewId, {
      roundStore: h.roundStore,
      sessionStore: h.sessionStore,
      run: h.run,
      observable: h.observable,
    })).resolves.toMatchObject({
      kind: "terminal-cleanup-completed",
      reviewId: h.reviewId,
      state: "tainted",
    });
    expect(h.round).toMatchObject({ state: "tainted", cleanupPending: false });
  });

  test("an external stop racing owned cleanup remains tainted", async () => {
    const h = recoveryHarness({ externalStopRaceReviewer: "codex" });
    await expect(reconcileReview(h.reviewId, {
      roundStore: h.roundStore,
      sessionStore: h.sessionStore,
      run: h.run,
      observable: h.observable,
    })).rejects.toThrow("tainted by external stop");
    expect(h.round.state).toBe("tainted");
  });

  test("a forged cleanup marker with the public result id cannot erase an external stop", async () => {
    const h = recoveryHarness({ forgedOwnedCleanupReviewer: "codex" });
    await expect(reconcileReview(h.reviewId, {
      roundStore: h.roundStore,
      sessionStore: h.sessionStore,
      run: h.run,
      observable: h.observable,
    })).rejects.toThrow("tainted by external stop from external@host");
    expect(h.round.state).toBe("tainted");
  });

  test("rewriting any byte of the parent-checkpointed Wux event prefix taints recovery", async () => {
    const h = recoveryHarness();
    const path = `${h.evidence.codex.evidencePath}/events.jsonl`;
    h.files.set(path, h.files.get(path)!.replace("2026-", "2025-"));
    await expect(reconcileReview(h.reviewId, {
      roundStore: h.roundStore,
      sessionStore: h.sessionStore,
      run: h.run,
      observable: h.observable,
    })).rejects.toThrow("malformed or rewritten Wux event evidence");
    expect(h.round.state).toBe("tainted");
  });

  test("parses the exact prefix bytes it authenticates during reconciliation", async () => {
    const h = recoveryHarness();
    const path = `${h.evidence.codex.evidencePath}/events.jsonl`;
    const create = JSON.stringify({
      type: "create",
      at: "2026-07-28T00:00:00Z",
      run: h.evidence.codex.childName,
    });
    const stopped = JSON.stringify({
      type: "stop",
      at: "2026-07-28T00:00:01Z",
      run: h.evidence.codex.childName,
      by: "external@host",
    });
    const ignored = stopped.replace('"stop"', '"noop"');
    const authenticated = `${create}\n${stopped}\n`;
    const rewritten = `${create}\n${ignored}\n`;
    expect(Buffer.byteLength(rewritten)).toBe(Buffer.byteLength(authenticated));
    h.files.set(path, authenticated);
    h.evidence.codex.eventPrefix = {
      bytes: Buffer.byteLength(authenticated),
      sha256: createHash("sha256").update(authenticated).digest("hex"),
    };
    h.round.evidence.codex[0]!.eventPrefix = h.evidence.codex.eventPrefix;
    const readChunk = h.observable.readChunk;
    let servedAuthenticatedPrefix = false;
    h.observable.readChunk = async (
      candidate: string,
      offset: number,
      maxBytes: number,
    ) => {
      const bytes = await readChunk(candidate, offset, maxBytes);
      if (candidate === path && offset === 0 && !servedAuthenticatedPrefix) {
        servedAuthenticatedPrefix = true;
        h.files.set(path, rewritten);
      }
      return bytes;
    };
    await expect(reconcileReview(h.reviewId, {
      roundStore: h.roundStore,
      sessionStore: h.sessionStore,
      run: h.run,
      observable: h.observable,
    })).rejects.toThrow("tainted by external stop from external@host");
    expect(h.round.state).toBe("tainted");
  });

  test("successful recovery removes wrapper-owned prompt, output, and isolated home remnants", async () => {
    const h = recoveryHarness();
    const promptPath = "/tmp/recovery/recover-review-r1-codex-prompt.md";
    const outputPath = "/tmp/recovery/recover-review-r1-codex-last.txt";
    const cleanupDir = `${tmpdir()}/wuxr-codex-home-recovery`;
    Object.assign(h.evidence.codex, {
      cleanupFiles: [promptPath, outputPath],
      cleanupDir,
    });
    Object.assign(h.round.evidence.codex[0]!, {
      cleanupFiles: [promptPath, outputPath],
      cleanupDir,
    });
    h.files.set(promptPath, "diff-bearing prompt");
    h.files.set(outputPath, REPORT);
    h.files.set(cleanupDir, "isolated home");
    await expect(reconcileReview(h.reviewId, {
      roundStore: h.roundStore,
      sessionStore: h.sessionStore,
      run: h.run,
      observable: h.observable,
    })).resolves.toMatchObject({ verdict: "approve" });
    expect(h.files.has(promptPath)).toBe(false);
    expect(h.files.has(outputPath)).toBe(false);
    expect(h.files.has(cleanupDir)).toBe(false);
  });

  test("preserves the existing Codex retry count and accepts only the final successful attempt", async () => {
    const h = recoveryHarness({ codexRetry: true });
    await expect(reconcileReview(h.reviewId, {
      roundStore: h.roundStore,
      sessionStore: h.sessionStore,
      run: h.run,
      observable: h.observable,
    })).resolves.toMatchObject({ verdict: "approve" });
    expect(h.codexRetry).toBeDefined();
    expect(h.round.evidence.codex.map((entry) => entry.attempt)).toEqual([1, 2]);
    expect(h.calls.every((call) => call.cmd[0] === "wux")).toBe(true);
    expect(h.round.state).toBe("reconciled");
  });

  test("a finished retry cannot delete shared Codex resources while a later attempt is live", async () => {
    const h = recoveryHarness({
      codexRetry: true,
      liveChildName: "recover-review-r1-codex-a2",
    });
    const promptPath = "/tmp/recovery/shared-codex-prompt.md";
    const outputPath = "/tmp/recovery/shared-codex-last.txt";
    const cleanupDir = `${tmpdir()}/wuxr-codex-home-shared-recovery`;
    for (const entry of [h.evidence.codex, h.codexRetry!]) {
      Object.assign(entry, {
        cleanupFiles: [promptPath, outputPath],
        cleanupDir,
      });
    }
    for (const entry of h.round.evidence.codex) {
      Object.assign(entry, {
        cleanupFiles: [promptPath, outputPath],
        cleanupDir,
      });
    }
    h.files.set(promptPath, "shared prompt");
    h.files.set(outputPath, REPORT);
    h.files.set(cleanupDir, "shared home");
    await expect(reconcileReview(h.reviewId, {
      roundStore: h.roundStore,
      sessionStore: h.sessionStore,
      run: h.run,
      observable: h.observable,
    })).rejects.toThrow("is still running");
    expect(h.files.get(promptPath)).toBe("shared prompt");
    expect(h.files.get(outputPath)).toBe(REPORT);
    expect(h.files.get(cleanupDir)).toBe("shared home");
    expect(h.round.state).toBe("interrupted");

    h.setChildLive(h.codexRetry!.childName, false);
    await expect(reconcileReview(h.reviewId, {
      roundStore: h.roundStore,
      sessionStore: h.sessionStore,
      run: h.run,
      observable: h.observable,
    })).resolves.toMatchObject({ verdict: "approve" });
    expect(h.files.has(promptPath)).toBe(false);
    expect(h.files.has(outputPath)).toBe(false);
    expect(h.files.has(cleanupDir)).toBe(false);
  });

  test("cross-leg swaps and duplicate identities fail before model calls and clean exact children", async () => {
    const h = recoveryHarness({
      mutateRecord: (record) => {
        record.evidence.claude[0]!.reviewer = "codex";
      },
    });
    await expect(reconcileReview(h.reviewId, {
      roundStore: h.roundStore,
      sessionStore: h.sessionStore,
      run: h.run,
      observable: h.observable,
    })).rejects.toThrow("duplicated, stale, or cross-leg");
    expect(h.calls.length).toBeGreaterThan(0);
    expect(h.calls.every((call) => call.cmd[0] === "wux")).toBe(true);

    const duplicate = recoveryHarness({
      mutateRecord: (record) => {
        record.evidence.codex[0]!.resultId = record.evidence.claude[0]!.resultId;
      },
    });
    await expect(reconcileReview(duplicate.reviewId, {
      roundStore: duplicate.roundStore,
      sessionStore: duplicate.sessionStore,
      run: duplicate.run,
      observable: duplicate.observable,
    })).rejects.toThrow("identity is duplicated");
    expect(duplicate.calls.length).toBeGreaterThan(0);
    expect(duplicate.calls.every((call) => call.cmd[0] === "wux")).toBe(true);
  });

  test("changed session state rejects stale recovery rather than attaching to another round", async () => {
    const prior: SessionState = {
      version: 1,
      round: 1,
      results: {
        claude: { reviewer: "claude", findings: [], verdict: "approve" },
        codex: { reviewer: "codex", findings: [], verdict: "approve" },
      },
      sticky: { claude: [], codex: [] },
      ledger: { claude: [], codex: [] },
    };
    const h = recoveryHarness({ prior });
    await expect(reconcileReview(h.reviewId, {
      roundStore: h.roundStore,
      sessionStore: h.sessionStore,
      run: h.run,
      observable: h.observable,
    })).rejects.toThrow("session state changed since launch");
    expect(h.calls.length).toBeGreaterThan(0);
    expect(h.calls.every((call) => call.cmd[0] === "wux")).toBe(true);
  });

  test("an unreliable recovery session read preserves evidence for a retry", async () => {
    const h = recoveryHarness();
    await expect(reconcileReview(h.reviewId, {
      roundStore: h.roundStore,
      sessionStore: {
        ...h.sessionStore,
        async loadForCompare() {
          return { state: undefined, reliable: false };
        },
      },
      acquireObservableLock: async () => async () => {},
      run: h.run,
      observable: h.observable,
    })).rejects.toMatchObject({ state: "interrupted" });
    expect(h.calls).toHaveLength(0);
    expect(h.round.state).toBe("interrupted");
    expect(h.files.has(`${h.evidence.codex.transientBase}-observable-done`))
      .toBe(true);
  });

  test("changed durable prompt evidence cannot be accepted as the recorded round", async () => {
    const h = recoveryHarness();
    h.files.set(
      `${h.evidence.claude.evidencePath}/prompt.md`,
      "different prompt",
    );
    await expect(reconcileReview(h.reviewId, {
      roundStore: h.roundStore,
      sessionStore: h.sessionStore,
      run: h.run,
      observable: h.observable,
    })).rejects.toThrow("missing or mismatched durable prompt evidence");
    expect(h.round.state).toBe("failed");
    expect(h.savedSessions.has(h.reviewId)).toBe(false);
  });

  test("a malformed completion marker cannot be normalized into a replayable result", async () => {
    const h = recoveryHarness();
    h.files.set(
      `${h.evidence.codex.transientBase}-observable-done`,
      "not-an-exit-code",
    );
    await expect(reconcileReview(h.reviewId, {
      roundStore: h.roundStore,
      sessionStore: h.sessionStore,
      run: h.run,
      observable: h.observable,
    })).rejects.toThrow("malformed completion marker");
    expect(h.round.state).toBe("failed");
    expect(h.files.has(`${h.evidence.codex.evidencePath}/result.json`)).toBe(false);
  });

  test("missing or invalid pane status cannot determine a recovery verdict", async () => {
    for (const status of [undefined, "null"]) {
      const h = recoveryHarness();
      const path = `${h.evidence.claude.evidencePath}/status.json`;
      if (status === undefined) h.files.delete(path);
      else h.files.set(path, status);
      await expect(reconcileReview(h.reviewId, {
        roundStore: h.roundStore,
        sessionStore: h.sessionStore,
        run: h.run,
        observable: h.observable,
      })).resolves.toMatchObject({ verdict: "approve" });
      expect(JSON.parse(h.files.get(path)!)).toMatchObject({
        status: "reconciled",
        childName: h.evidence.claude.childName,
        result: { state: "final", code: 0 },
      });
    }
  });

  test("a partial atomic result is rejected, retained as incident evidence, and not left transient", async () => {
    const h = recoveryHarness();
    h.files.set(
      `${h.evidence.codex.resultPath}.tmp`,
      '{"partial":true',
    );
    await expect(reconcileReview(h.reviewId, {
      roundStore: h.roundStore,
      sessionStore: h.sessionStore,
      run: h.run,
      observable: h.observable,
    })).rejects.toThrow("partial atomic result.json.tmp");
    expect(h.files.has(`${h.evidence.codex.resultPath}.tmp`)).toBe(false);
    expect(h.files.get(`${h.evidence.codex.evidencePath}/result.rejected.json`))
      .toBe('{"partial":true');
  });

  test("a partial atomic result is rejected even when result.json also exists", async () => {
    const h = recoveryHarness();
    const record = h.evidence.codex;
    h.files.set(record.resultPath, `${JSON.stringify({
      version: 1,
      identity: {
        id: record.resultId,
        reviewId: h.reviewId,
        round: 1,
        reviewer: record.reviewer,
        childName: record.childName,
        attempt: record.attempt,
        promptSha256: record.promptSha256,
      },
      process: { code: 0, stdout: "", stderr: "", timedOut: false },
      output: REPORT,
    })}\n`);
    h.files.set(`${record.resultPath}.tmp`, '{"partial":true');
    await expect(reconcileReview(h.reviewId, {
      roundStore: h.roundStore,
      sessionStore: h.sessionStore,
      run: h.run,
      observable: h.observable,
    })).rejects.toThrow("partial atomic result.json.tmp");
    expect(h.files.has(`${record.resultPath}.tmp`)).toBe(false);
    expect(h.files.get(`${record.evidencePath}/result.rejected.json`))
      .toBe('{"partial":true');
  });

  test("a transient evidence read failure retains the zero-call recovery path", async () => {
    const h = recoveryHarness();
    const snapshotSize = h.observable.snapshotSize;
    const claudeStdout = `${h.evidence.claude.transientBase}-observable-stdout`;
    let failRead = true;
    h.observable.snapshotSize = async (path) => {
      if (failRead && path === claudeStdout) {
        failRead = false;
        throw new Error("EIO reading reviewer stream");
      }
      return snapshotSize(path);
    };

    await expect(reconcileReview(h.reviewId, {
      roundStore: h.roundStore,
      sessionStore: h.sessionStore,
      run: h.run,
      observable: h.observable,
    })).rejects.toThrow("EIO reading reviewer stream");
    expect(h.round.state).toBe("interrupted");
    expect(h.files.has(claudeStdout)).toBe(true);
    expect(h.files.has(`${h.evidence.claude.transientBase}-observable-done`))
      .toBe(true);
    expect(h.calls.some((call) =>
      call.cmd.includes("stop")
      && call.cmd.includes(h.evidence.claude.childName)
    )).toBe(false);

    await expect(reconcileReview(h.reviewId, {
      roundStore: h.roundStore,
      sessionStore: h.sessionStore,
      run: h.run,
      observable: h.observable,
    })).resolves.toMatchObject({ verdict: "approve" });
    expect(h.round.state).toBe("reconciled");
  });
});

function makeEvidence(
  reviewer: "claude" | "codex",
  reviewId: string,
): LegExecutionEvidence {
  const childName = `${reviewId}-r1-${reviewer}`;
  return {
    reviewer,
    childName,
    attempt: 1,
    evidencePath: `/evidence/${childName}`,
    resultPath: `/evidence/${childName}/result.json`,
    resultId: `result-${reviewer}`,
    promptSha256: createHash("sha256")
      .update(`PROMPT-${reviewer}`)
      .digest("hex"),
    transientBase: `/tmp/recovery/${childName}`,
    ownedCleanupKey: reviewer === "claude" ? "a".repeat(64) : "b".repeat(64),
  };
}

function cleanupProof(
  record: LegExecutionEvidence,
  stopAt: string,
  stopBy: string,
): string {
  return createHmac("sha256", record.ownedCleanupKey!)
    .update("wux-review-owned-cleanup\0")
    .update(record.childName)
    .update("\0")
    .update(record.resultId)
    .update("\0")
    .update(stopAt)
    .update("\0")
    .update(stopBy)
    .digest("hex");
}
