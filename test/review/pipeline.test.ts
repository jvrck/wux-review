import { describe, expect, test } from "bun:test";
import { runReview, type ReviewDeps } from "../../src/review/pipeline";
import { reconcileReview } from "../../src/review/observable-recovery";
import type {
  ObservableRoundRecord,
  ObservableRoundStore,
} from "../../src/review/observable-lifecycle";
import type { Backend } from "../../src/review/reviewers";
import type { SessionStore } from "../../src/review/session-state";
import type { SessionState } from "../../src/review/types";

const report = (findings: unknown[]): string => "```json\n" + JSON.stringify({ findings }) + "\n```";

// An in-memory session store so a two-round re-review runs without touching disk.
function memStore(): { store: SessionStore; data: Map<string, SessionState> } {
  const data = new Map<string, SessionState>();
  return {
    data,
    store: {
      async load(id) {
        return data.get(id);
      },
      async save(id, s) {
        data.set(id, s);
      },
      async clear(id) {
        data.delete(id);
      },
    },
  };
}

// A scripted reviewer leg: returns round N's findings and records the prompt it
// was shown, so a test can drive successive rounds AND assert what context each
// round fed in (the whole point of #91 — that prior findings reach the prompt).
function scripted(rounds: unknown[][]): { backend: Backend; prompts: string[] } {
  const prompts: string[] = [];
  let round = 0;
  const backend: Backend = async (prompt) => {
    prompts.push(prompt);
    const findings = rounds[round] ?? [];
    round++;
    return report(findings);
  };
  return { backend, prompts };
}

function deps(claude: Backend, codex: Backend, store: SessionStore): ReviewDeps {
  return {
    loadConfig: async () => ({}),
    getDiff: async () => ({ diff: "diff --git a/app.ts b/app.ts\n+changed\n", files: ["app.ts"] }),
    backends: { claude, codex },
    sessionStore: store,
  };
}

describe("runReview", () => {
  test("rejects a ref combined with a pr (mutually exclusive targets)", async () => {
    await expect(runReview({ ref: "HEAD~1", pr: 7 }, { loadConfig: async () => ({}) })).rejects.toThrow("not both");
  });

  // #100: the envelope carries a 1-based round, sourced from and persisted to the
  // session state, so a re-review's in-place comment edit is detectable.
  test("stamps a 1-based round on the envelope and increments it each --session re-review", async () => {
    const claude = scripted([[], [], []]);
    const codex = scripted([[], [], []]);
    const { store, data } = memStore();
    const d = deps(claude.backend, codex.backend, store);

    const r1 = await runReview({ session: "sround" }, d);
    expect(r1.round).toBe(1);
    expect(data.get("sround")?.round).toBe(1);

    const r2 = await runReview({ session: "sround" }, d);
    expect(r2.round).toBe(2);
    expect(data.get("sround")?.round).toBe(2);

    const r3 = await runReview({ session: "sround" }, d);
    expect(r3.round).toBe(3);
    expect(data.get("sround")?.round).toBe(3);
  });

  test("direct session reviews hold the shared round lock from prior-state read through commit", async () => {
    const claude = scripted([[]]);
    const codex = scripted([[]]);
    const { store, data } = memStore();
    let locked = false;
    const guardedStore: SessionStore = {
      async load(id) {
        expect(locked).toBe(true);
        return store.load(id);
      },
      async save(id, state) {
        expect(locked).toBe(true);
        await store.save(id, state);
      },
      async clear(id) {
        await store.clear(id);
      },
    };
    await expect(runReview(
      { session: "sdirectlock" },
      {
        ...deps(claude.backend, codex.backend, guardedStore),
        acquireObservableLock: async (reviewId) => {
          expect(reviewId).toBe("sdirectlock");
          expect(locked).toBe(false);
          locked = true;
          return async () => {
            expect(locked).toBe(true);
            locked = false;
          };
        },
      },
    )).resolves.toMatchObject({ verdict: "approve", round: 1 });
    expect(locked).toBe(false);
    expect(data.get("sdirectlock")?.round).toBe(1);
  });

  test("a final state-hash guard refuses to overwrite a newer concurrent session round", async () => {
    const approved = (reviewer: "claude" | "codex") => ({
      reviewer,
      findings: [],
      verdict: "approve" as const,
    });
    let state: SessionState = {
      version: 1,
      round: 1,
      results: {
        claude: approved("claude"),
        codex: approved("codex"),
      },
      sticky: { claude: [], codex: [] },
      ledger: { claude: [], codex: [] },
    };
    let recovery: ObservableRoundRecord | undefined;
    await expect(runReview(
      { session: "srace", inspect: true },
      {
        loadConfig: async () => ({}),
        getDiff: async () => ({
          diff: "diff --git a/x b/x\n+x\n",
          files: ["x"],
        }),
        sessionStore: {
          async load() {
            return structuredClone(state);
          },
          async save(_id, next) {
            state = structuredClone(next);
          },
          async clear() {},
        },
        observableRoundStore: {
          async load() {
            return recovery;
          },
          async save(record) {
            recovery = structuredClone(record);
          },
          async clear() {},
          async prune() {},
        },
        // Model a defective/non-serializing injected lock: the independent
        // final hash check must still refuse the stale write.
        acquireObservableLock: async () => async () => {},
        runReviewers: async (_diff, _lenses, options) => {
          await options!.prepareObservableRound!({
            reviewId: "srace",
            round: 2,
            executionId: "exec2",
            claudeChildName: "wuxr-srace-r2-xexec2-claude",
            codexChildName: "wuxr-srace-r2-xexec2-codex",
          });
          state = { ...state, round: 99 };
          return {
            sessionId: "srace",
            claude: approved("claude"),
            codex: approved("codex"),
            evidence: { claude: [], codex: [] },
          };
        },
      },
    )).rejects.toThrow(
      "state changed while reviewers were running; refusing to overwrite the newer round",
    );
    expect(state.round).toBe(99);
    expect(recovery?.state).toBe("failed");
    expect(recovery?.diagnostic).not.toContain("reconcile the existing evidence");
  });

  test("a direct-session guard read failure skips persistence without losing the verdict", async () => {
    let loads = 0;
    let saves = 0;
    const store: SessionStore = {
      async load() {
        loads++;
        if (loads === 1) return undefined;
        throw new Error("transient session read failure");
      },
      async save() {
        saves++;
      },
      async clear() {},
    };
    await expect(runReview(
      { session: "directreadfail" },
      {
        loadConfig: async () => ({}),
        getDiff: async () => ({ diff: "diff --git a/x b/x\n+x\n", files: ["x"] }),
        sessionStore: store,
        acquireObservableLock: async () => async () => {},
        runReviewers: async () => ({
          sessionId: "directreadfail",
          claude: { reviewer: "claude", findings: [], verdict: "approve" },
          codex: { reviewer: "codex", findings: [], verdict: "approve" },
        }),
      },
    )).resolves.toMatchObject({ verdict: "approve", round: 1 });
    expect(loads).toBe(2);
    expect(saves).toBe(0);
  });

  test("a corrupt direct-session comparison snapshot is atomically self-healed", async () => {
    let saves = 0;
    const store: SessionStore = {
      async load() {
        return undefined;
      },
      async loadForCompare() {
        return { state: undefined, reliable: false, corrupt: true };
      },
      async save() {
        saves++;
      },
      async clear() {},
    };
    await expect(runReview(
      { session: "directcorrupt" },
      {
        loadConfig: async () => ({}),
        getDiff: async () => ({ diff: "diff --git a/x b/x\n+x\n", files: ["x"] }),
        sessionStore: store,
        acquireObservableLock: async () => async () => {},
        runReviewers: async () => ({
          sessionId: "directcorrupt",
          claude: { reviewer: "claude", findings: [], verdict: "approve" },
          codex: { reviewer: "codex", findings: [], verdict: "approve" },
        }),
      },
    )).resolves.toMatchObject({ verdict: "approve", round: 1 });
    expect(saves).toBe(1);
  });

  test("a known newer direct-session state skips persistence without losing the verdict", async () => {
    let current: SessionState | undefined;
    let saves = 0;
    const store: SessionStore = {
      async load() {
        return current;
      },
      async loadForCompare() {
        return { state: current, reliable: true };
      },
      async save(_id, state) {
        saves++;
        current = state;
      },
      async clear() {},
    };
    await expect(runReview(
      { session: "directnewer" },
      {
        loadConfig: async () => ({}),
        getDiff: async () => ({ diff: "diff --git a/x b/x\n+x\n", files: ["x"] }),
        sessionStore: store,
        acquireObservableLock: async () => async () => {},
        runReviewers: async () => {
          current = {
            version: 1,
            round: 99,
            results: {
              claude: { reviewer: "claude", findings: [], verdict: "approve" },
              codex: { reviewer: "codex", findings: [], verdict: "approve" },
            },
            sticky: { claude: [], codex: [] },
            ledger: { claude: [], codex: [] },
          };
          return {
            sessionId: "directnewer",
            claude: { reviewer: "claude", findings: [], verdict: "approve" },
            codex: { reviewer: "codex", findings: [], verdict: "approve" },
          };
        },
      },
    )).resolves.toMatchObject({ verdict: "approve", round: 1 });
    expect(saves).toBe(0);
    expect(current?.round).toBe(99);
  });

  test("an unreliable observable pre-launch comparison fails before model calls", async () => {
    let reviewerCalls = 0;
    const store: SessionStore = {
      async load() {
        return undefined;
      },
      async loadForCompare() {
        return { state: undefined, reliable: false };
      },
      async save() {},
      async clear() {},
    };
    await expect(runReview(
      { session: "observableunreliable", inspect: true },
      {
        loadConfig: async () => ({}),
        getDiff: async () => ({ diff: "diff --git a/x b/x\n+x\n", files: ["x"] }),
        sessionStore: store,
        acquireObservableLock: async () => async () => {},
        runReviewers: async () => {
          reviewerCalls++;
          throw new Error("reviewers must not launch");
        },
      },
    )).rejects.toThrow("session state could not be read reliably");
    expect(reviewerCalls).toBe(0);
  });

  test("an unreliable observable final comparison preserves replayable evidence", async () => {
    let comparisons = 0;
    let sessionSaves = 0;
    let current: ObservableRoundRecord | undefined;
    const roundStore: ObservableRoundStore = {
      async load() {
        return current;
      },
      async save(record) {
        current = structuredClone(record);
      },
      async clear() {},
      async prune() {},
    };
    await expect(runReview(
      { session: "observablefinalread", inspect: true },
      {
        loadConfig: async () => ({}),
        getDiff: async () => ({ diff: "diff --git a/x b/x\n+x\n", files: ["x"] }),
        sessionStore: {
          async load() {
            return undefined;
          },
          async loadForCompare() {
            comparisons++;
            return { state: undefined, reliable: comparisons === 1 };
          },
          async save() {
            sessionSaves++;
          },
          async clear() {},
        },
        observableRoundStore: roundStore,
        acquireObservableLock: async () => async () => {},
        runReviewers: async (_diff, _lenses, options) => {
          await options!.prepareObservableRound!({
            reviewId: "observablefinalread",
            round: 1,
            executionId: "exec1",
            claudeChildName: "wuxr-observablefinalread-r1-xexec1-claude",
            codexChildName: "wuxr-observablefinalread-r1-xexec1-codex",
          });
          return {
            sessionId: "observablefinalread",
            claude: { reviewer: "claude", findings: [], verdict: "approve" },
            codex: { reviewer: "codex", findings: [], verdict: "approve" },
            evidence: { claude: [], codex: [] },
          };
        },
      },
    )).rejects.toMatchObject({ state: "interrupted" });
    expect(comparisons).toBe(2);
    expect(sessionSaves).toBe(0);
    expect(current?.state).toBe("interrupted");
    expect(current?.diagnostic).toContain("session state could not be read reliably");
  });

  test("a one-shot review (no --session) is round 1 and persists nothing", async () => {
    const claude = scripted([[]]);
    const codex = scripted([[]]);
    const { store, data } = memStore();
    const r = await runReview({}, deps(claude.backend, codex.backend, store));
    expect(r.round).toBe(1);
    expect(data.size).toBe(0);
  });

  test("candidate observable rounds persist additive child/evidence/result identity in session state", async () => {
    const { store, data } = memStore();
    let recovery: ObservableRoundRecord | undefined;
    const d: ReviewDeps = {
      loadConfig: async () => ({}),
      getDiff: async () => ({ diff: "diff --git a/x b/x\n+x\n", files: ["x"] }),
      sessionStore: store,
      observableRoundStore: {
        async load() {
          return recovery;
        },
        async save(record) {
          recovery = structuredClone(record);
        },
        async clear() {},
        async prune() {},
      },
      acquireObservableLock: async () => async () => {},
      runReviewers: async (_diff, _lenses, options) => {
        const round = options?.round ?? 1;
        await options!.prepareObservableRound!({
          reviewId: "sobs",
          round,
          executionId: `exec${round}`,
          claudeChildName: `obs-sobs-r${round}-claude`,
          codexChildName: `obs-sobs-r${round}-codex`,
        });
        const record = (reviewer: "claude" | "codex") => {
          const childName = `obs-sobs-r${round}-${reviewer}`;
          return {
            reviewer,
            childName,
            attempt: 1,
            evidencePath: `/evidence/${childName}`,
            resultPath: `/evidence/${childName}/result.json`,
            resultId: `${reviewer}-result-r${round}`,
            promptSha256: "b".repeat(64),
            transientBase: `/tmp/wux-review/${childName}`,
          };
        };
        const claudeEvidence = record("claude");
        const codexEvidence = record("codex");
        await options!.recordObservableEvidence!(claudeEvidence);
        await options!.recordObservableEvidence!(codexEvidence);
        await options!.finishObservableRound!("completed");
        return {
          sessionId: options?.sessionId ?? "sobs",
          claude: { reviewer: "claude", findings: [], verdict: "approve" },
          codex: { reviewer: "codex", findings: [], verdict: "approve" },
          evidence: { claude: [claudeEvidence], codex: [codexEvidence] },
        };
      },
    };

    await runReview({ session: "sobs", inspect: true }, d);
    await runReview({ session: "sobs", inspect: true }, d);
    const children = data.get("sobs")?.children;
    expect(children).toHaveLength(2);
    expect(children?.map((entry) => entry.round)).toEqual([1, 2]);
    expect(children?.[1]?.codex[0]).toMatchObject({
      childName: "obs-sobs-r2-codex",
      resultId: "codex-result-r2",
      resultPath: "/evidence/obs-sobs-r2-codex/result.json",
    });
  });

  test("pipeline observable wiring journals finalization before committing the session", async () => {
    const { store } = memStore();
    let current: ObservableRoundRecord | undefined;
    const states: string[] = [];
    let prunes = 0;
    let locked = false;
    const roundStore: ObservableRoundStore = {
      async load() {
        return current === undefined ? undefined : structuredClone(current);
      },
      async save(record) {
        current = structuredClone(record);
        states.push(record.state);
      },
      async clear() {},
      async prune() {
        prunes++;
      },
    };
    const d: ReviewDeps = {
      loadConfig: async () => ({}),
      getDiff: async () => ({ diff: "diff --git a/x b/x\n+x\n", files: ["x"] }),
      sessionStore: {
        ...store,
        async save(id, state) {
          expect(locked).toBe(true);
          await store.save(id, state);
        },
      },
      observableRoundStore: roundStore,
      acquireObservableLock: async () => {
        expect(locked).toBe(false);
        locked = true;
        return async () => {
          locked = false;
        };
      },
      runReviewers: async (_diff, _lenses, options) => {
        expect(locked).toBe(true);
        await options!.prepareObservableRound!({
          reviewId: "pipelineobs",
          round: 1,
          executionId: "exec1",
          claudeChildName: "wuxr-pipelineobs-r1-xexec1-claude",
          codexChildName: "wuxr-pipelineobs-r1-xexec1-codex",
        });
        const evidence = (reviewer: "claude" | "codex") => {
          const childName = `wuxr-pipelineobs-r1-xexec1-${reviewer}`;
          return {
            reviewer,
            childName,
            attempt: 1,
            evidencePath: `/evidence/${childName}`,
            resultPath: `/evidence/${childName}/result.json`,
            resultId: `${reviewer}-result`,
            promptSha256: "a".repeat(64),
            transientBase: `/tmp/wux-review/${childName}`,
          };
        };
        const claudeEvidence = evidence("claude");
        const codexEvidence = evidence("codex");
        await Promise.all([
          options!.recordObservableEvidence!(claudeEvidence),
          options!.recordObservableEvidence!(codexEvidence),
        ]);
        await options!.finishObservableRound!("completed");
        return {
          sessionId: "pipelineobs",
          claude: { reviewer: "claude", findings: [], verdict: "approve" },
          codex: { reviewer: "codex", findings: [], verdict: "approve" },
          evidence: {
            claude: [claudeEvidence],
            codex: [codexEvidence],
          },
        };
      },
    };

    await expect(runReview(
      { session: "pipelineobs", inspect: true },
      d,
    )).resolves.toMatchObject({ verdict: "approve" });
    expect(prunes).toBe(1);
    expect(states).toEqual([
      "pending",
      "running",
      "running",
      "finalizing",
      "completed",
    ]);
    expect(current?.finalization?.sessionStateSha256).toMatch(/^[0-9a-f]{64}$/);
    expect(current?.evidence.claude).toHaveLength(1);
    expect(current?.evidence.codex).toHaveLength(1);
    expect(locked).toBe(false);
  });

  test("pipeline journals an exact Codex retry before its Wux launch", async () => {
    let current: ObservableRoundRecord | undefined;
    const baseChild = "wuxr-prepretry-r1-xexec1-codex";
    await expect(runReview(
      { session: "prepretry", inspect: true },
      {
        loadConfig: async () => ({}),
        getDiff: async () => ({ diff: "diff --git a/x b/x\n+x\n", files: ["x"] }),
        sessionStore: {
          async load() {
            return undefined;
          },
          async save() {},
          async clear() {},
        },
        observableRoundStore: {
          async load() {
            return current;
          },
          async save(record) {
            current = structuredClone(record);
          },
          async clear() {},
          async prune() {},
        },
        acquireObservableLock: async () => async () => {},
        runReviewers: async (_diff, _lenses, options) => {
          await options!.prepareObservableRound!({
            reviewId: "prepretry",
            round: 1,
            executionId: "exec1",
            claudeChildName: "wuxr-prepretry-r1-xexec1-claude",
            codexChildName: baseChild,
          });
          await options!.recordObservablePreparedChild!(
            "codex",
            `${baseChild}-a2`,
            2,
          );
          throw new Error("simulated crash before Wux retry launch");
        },
      },
    )).rejects.toThrow("simulated crash before Wux retry launch");
    expect(current?.prepared).toEqual({
      claude: ["wuxr-prepretry-r1-xexec1-claude"],
      codex: [baseChild, `${baseChild}-a2`],
    });
  });

  test("an interrupt racing the finalizing journal prevents session commit and remains replayable", async () => {
    const signal = new AbortController();
    let current: ObservableRoundRecord | undefined;
    let sessionSaved = false;
    const approved = (reviewer: "claude" | "codex") => ({
      reviewer,
      findings: [],
      verdict: "approve" as const,
    });
    await expect(runReview(
      { session: "pipelineinterrupt", inspect: true, signal: signal.signal },
      {
        loadConfig: async () => ({}),
        getDiff: async () => ({
          diff: "diff --git a/x b/x\n+x\n",
          files: ["x"],
        }),
        sessionStore: {
          async load() {
            return undefined;
          },
          async save() {
            sessionSaved = true;
          },
          async clear() {},
        },
        observableRoundStore: {
          async load() {
            return current;
          },
          async save(record) {
            current = structuredClone(record);
            if (record.state === "finalizing") {
              signal.abort("parent-interrupted");
            }
          },
          async clear() {},
          async prune() {},
        },
        acquireObservableLock: async () => async () => {},
        runReviewers: async (_diff, _lenses, options) => {
          await options!.prepareObservableRound!({
            reviewId: "pipelineinterrupt",
            round: 1,
            executionId: "exec1",
            claudeChildName: "wuxr-pipelineinterrupt-r1-xexec1-claude",
            codexChildName: "wuxr-pipelineinterrupt-r1-xexec1-codex",
          });
          return {
            sessionId: "pipelineinterrupt",
            claude: approved("claude"),
            codex: approved("codex"),
            evidence: { claude: [], codex: [] },
          };
        },
      },
    )).rejects.toMatchObject({ state: "interrupted" });
    expect(sessionSaved).toBe(false);
    expect(current).toMatchObject({
      state: "interrupted",
      finalization: {
        sessionStateSha256: expect.stringMatching(/^[0-9a-f]{64}$/),
      },
    });
    expect(current?.diagnostic).toContain(
      "observable review interrupted during finalization",
    );
  });

  test("an interrupt during session persistence leaves a committed target for zero-call reconciliation", async () => {
    const signal = new AbortController();
    let current: ObservableRoundRecord | undefined;
    let session: SessionState | undefined;
    const approved = (reviewer: "claude" | "codex") => ({
      reviewer,
      findings: [],
      verdict: "approve" as const,
    });
    const sessionStore: SessionStore = {
      async load() {
        return session;
      },
      async save(_id, state) {
        session = structuredClone(state);
        signal.abort("parent-interrupted");
      },
      async clear() {},
    };
    const roundStore: ObservableRoundStore = {
      async load() {
        return current;
      },
      async save(record) {
        current = structuredClone(record);
      },
      async clear() {},
      async prune() {},
    };
    await expect(runReview(
      { session: "pipelinepersistinterrupt", inspect: true, signal: signal.signal },
      {
        loadConfig: async () => ({}),
        getDiff: async () => ({
          diff: "diff --git a/x b/x\n+x\n",
          files: ["x"],
        }),
        sessionStore,
        observableRoundStore: roundStore,
        acquireObservableLock: async () => async () => {},
        runReviewers: async (_diff, _lenses, options) => {
          await options!.prepareObservableRound!({
            reviewId: "pipelinepersistinterrupt",
            round: 1,
            executionId: "exec1",
            claudeChildName: "wuxr-pipelinepersistinterrupt-r1-xexec1-claude",
            codexChildName: "wuxr-pipelinepersistinterrupt-r1-xexec1-codex",
          });
          return {
            sessionId: "pipelinepersistinterrupt",
            claude: approved("claude"),
            codex: approved("codex"),
            evidence: { claude: [], codex: [] },
          };
        },
      },
    )).rejects.toMatchObject({ state: "interrupted" });
    expect(session?.round).toBe(1);
    expect(current?.state).toBe("interrupted");

    let runnerCalls = 0;
    await expect(reconcileReview("pipelinepersistinterrupt", {
      roundStore,
      sessionStore,
      acquireObservableLock: async () => async () => {},
      run: async () => {
        runnerCalls++;
        throw new Error("a committed finalization must not call Wux or a model");
      },
    })).resolves.toMatchObject({ verdict: "approve", round: 1 });
    expect(runnerCalls).toBe(0);
    expect(current?.state).toBe("reconciled");
  });

  test("a failed observable session commit returns an interruption with replayable finalization", async () => {
    let current: ObservableRoundRecord | undefined;
    const savedRound = () => current;
    let completedSaveFailures = 0;
    const roundStore: ObservableRoundStore = {
      async load() {
        return current === undefined ? undefined : structuredClone(current);
      },
      async save(record) {
        if (record.state === "completed" && completedSaveFailures > 0) {
          completedSaveFailures--;
          throw new Error("round journal ENOSPC");
        }
        current = structuredClone(record);
      },
      async clear() {},
      async prune() {},
    };
    const runReviewers: NonNullable<ReviewDeps["runReviewers"]> = async (
      _diff,
      _lenses,
      options,
    ) => {
      await options!.prepareObservableRound!({
        reviewId: "pipelinecommit",
        round: 1,
        executionId: "exec1",
        claudeChildName: "wuxr-pipelinecommit-r1-xexec1-claude",
        codexChildName: "wuxr-pipelinecommit-r1-xexec1-codex",
      });
      const evidence = (reviewer: "claude" | "codex") => {
        const childName = `wuxr-pipelinecommit-r1-xexec1-${reviewer}`;
        return {
          reviewer,
          childName,
          attempt: 1,
          evidencePath: `/evidence/${childName}`,
          resultPath: `/evidence/${childName}/result.json`,
          resultId: `${reviewer}-result`,
          promptSha256: "a".repeat(64),
          transientBase: `/tmp/wux-review/${childName}`,
        };
      };
      const claudeEvidence = evidence("claude");
      const codexEvidence = evidence("codex");
      await options!.recordObservableEvidence!(claudeEvidence);
      await options!.recordObservableEvidence!(codexEvidence);
      await options!.finishObservableRound!("completed");
      return {
        sessionId: "pipelinecommit",
        claude: { reviewer: "claude", findings: [], verdict: "approve" },
        codex: { reviewer: "codex", findings: [], verdict: "approve" },
        evidence: {
          claude: [claudeEvidence],
          codex: [codexEvidence],
        },
      };
    };
    await expect(runReview(
      { session: "pipelinecommit", inspect: true },
      {
        loadConfig: async () => ({}),
        getDiff: async () => ({ diff: "diff --git a/x b/x\n+x\n", files: ["x"] }),
        sessionStore: {
          async load() {
            return undefined;
          },
          async save() {
            throw new Error("ENOSPC");
          },
          async clear() {},
        },
        observableRoundStore: roundStore,
        acquireObservableLock: async () => async () => {},
        runReviewers,
      },
    )).rejects.toMatchObject({ state: "interrupted" });
    expect(current).toMatchObject({
      state: "interrupted",
      finalization: {
        sessionStateSha256: expect.stringMatching(/^[0-9a-f]{64}$/),
      },
    });

    current = undefined;
    completedSaveFailures = 1;
    const committed = memStore();
    await expect(runReview(
      { session: "pipelinecommit", inspect: true },
      {
        loadConfig: async () => ({}),
        getDiff: async () => ({ diff: "diff --git a/x b/x\n+x\n", files: ["x"] }),
        sessionStore: committed.store,
        observableRoundStore: roundStore,
        acquireObservableLock: async () => async () => {},
        runReviewers,
      },
    )).rejects.toThrow("validated results could not be finalized");
    expect(committed.data.get("pipelinecommit")?.round).toBe(1);
    expect(savedRound()?.state).toBe("interrupted");
    let runnerCalls = 0;
    await expect(reconcileReview("pipelinecommit", {
      roundStore,
      sessionStore: committed.store,
      run: async () => {
        runnerCalls++;
        throw new Error("reconciliation must not call Wux or a model");
      },
    })).resolves.toMatchObject({ verdict: "approve", round: 1 });
    expect(runnerCalls).toBe(0);
    expect(savedRound()?.state).toBe("reconciled");
  });

  test("pipeline recovery guard blocks a finalizing round before model calls", async () => {
    let existing: ObservableRoundRecord = {
      version: 1,
      reviewId: "pipelinebusy",
      round: 1,
      executionId: "oldexec",
      sessionMode: true,
      priorStateSha256: null,
      expected: {
        claudeChildName: "old-claude",
        codexChildName: "old-codex",
      },
      ledger: { claude: [], codex: [] },
      evidence: { claude: [], codex: [] },
      state: "finalizing",
      startedAt: "2026-07-28T00:00:00Z",
      updatedAt: "2026-07-28T00:00:00Z",
      finalization: {
        sessionStateSha256: "a".repeat(64),
        results: {
          claude: { reviewer: "claude", findings: [], verdict: "approve" },
          codex: { reviewer: "codex", findings: [], verdict: "approve" },
        },
      },
    };
    let modelCalls = 0;
    const roundStore: ObservableRoundStore = {
      async load() {
        return existing;
      },
      async save() {},
      async clear() {},
      async prune() {},
    };
    const launch = () => runReview(
      { session: "pipelinebusy", inspect: true },
      {
        loadConfig: async () => ({}),
        getDiff: async () => ({ diff: "diff --git a/x b/x\n+x\n", files: ["x"] }),
        observableRoundStore: roundStore,
        acquireObservableLock: async () => async () => {},
        runReviewers: async (_diff, _lenses, options) => {
          await options!.prepareObservableRound!({
            reviewId: "pipelinebusy",
            round: 1,
            executionId: "newexec",
            claudeChildName: "new-claude",
            codexChildName: "new-codex",
          });
          modelCalls++;
          throw new Error("unreachable");
        },
      },
    );
    await expect(launch()).rejects.toThrow(
      "reconcile it before launching another model call",
    );
    const { finalization: _finalization, ...terminal } = existing;
    existing = {
      ...terminal,
      state: "failed",
      cleanupPending: true,
    };
    await expect(launch()).rejects.toThrow(
      "reconcile it before launching another model call",
    );
    expect(modelCalls).toBe(0);
  });

  test("normal observable cleanup failure journals cleanup-pending before replacement launch", async () => {
    let current: ObservableRoundRecord | undefined;
    let modelCalls = 0;
    const roundStore: ObservableRoundStore = {
      async load() {
        return current;
      },
      async save(record) {
        current = structuredClone(record);
      },
      async clear() {},
      async prune() {},
    };
    const launch = () => runReview(
      { session: "pipelinecleanup", inspect: true },
      {
        loadConfig: async () => ({}),
        getDiff: async () => ({ diff: "diff --git a/x b/x\n+x\n", files: ["x"] }),
        observableRoundStore: roundStore,
        acquireObservableLock: async () => async () => {},
        runReviewers: async (_diff, _lenses, options) => {
          await options!.prepareObservableRound!({
            reviewId: "pipelinecleanup",
            round: 1,
            executionId: "exec1",
            claudeChildName: "cleanup-claude",
            codexChildName: "cleanup-codex",
          });
          modelCalls++;
          await options!.finishObservableRound!(
            "failed",
            "terminal cleanup failed",
            true,
          );
          throw new Error("terminal cleanup failed");
        },
      },
    );
    await expect(launch()).rejects.toThrow("terminal cleanup failed");
    expect(current).toMatchObject({ state: "failed", cleanupPending: true });
    await expect(launch()).rejects.toThrow(
      "reconcile it before launching another model call",
    );
    expect(modelCalls).toBe(1);
  });

  test("pipeline normalizes an interrupted cleanup-pending callback to a terminal failure", async () => {
    let current: ObservableRoundRecord | undefined;
    const roundStore: ObservableRoundStore = {
      async load() {
        return current;
      },
      async save(record) {
        current = structuredClone(record);
      },
      async clear() {},
      async prune() {},
    };
    await expect(runReview(
      { session: "pipelineinterruptcleanup", inspect: true },
      {
        loadConfig: async () => ({}),
        getDiff: async () => ({ diff: "diff --git a/x b/x\n+x\n", files: ["x"] }),
        observableRoundStore: roundStore,
        acquireObservableLock: async () => async () => {},
        runReviewers: async (_diff, _lenses, options) => {
          await options!.prepareObservableRound!({
            reviewId: "pipelineinterruptcleanup",
            round: 1,
            executionId: "exec1",
            claudeChildName: "cleanup-claude",
            codexChildName: "cleanup-codex",
          });
          await options!.finishObservableRound!(
            "interrupted",
            "interrupt raced terminal cleanup",
            true,
          );
          throw new Error("terminal cleanup failed");
        },
      },
    )).rejects.toThrow("terminal cleanup failed");
    expect(current).toMatchObject({ state: "failed", cleanupPending: true });
  });

  test("an abort during preflight prevents observable lock acquisition and reviewer launch", async () => {
    const abort = new AbortController();
    let locks = 0;
    let reviewerCalls = 0;
    await expect(runReview(
      { session: "pipelineabort", inspect: true, signal: abort.signal },
      {
        loadConfig: async () => ({}),
        getDiff: async () => {
          abort.abort("parent-interrupted");
          return { diff: "diff --git a/x b/x\n+x\n", files: ["x"] };
        },
        acquireObservableLock: async () => {
          locks++;
          return async () => {};
        },
        runReviewers: async () => {
          reviewerCalls++;
          throw new Error("unreachable");
        },
      },
    )).rejects.toThrow("interrupted before child launch");
    expect(locks).toBe(0);
    expect(reviewerCalls).toBe(0);
  });

  test("released direct-headless session state remains unchanged (no empty children field)", async () => {
    const claude = scripted([[]]);
    const codex = scripted([[]]);
    const { store, data } = memStore();
    await runReview({ session: "sdirect" }, deps(claude.backend, codex.backend, store));
    expect(data.get("sdirect")?.children).toBeUndefined();
  });

  // #101 AC1 — the #213 replay: a wrong [security] must-fix (no repro), refuted with
  // a node -e counter-repro, re-raised in round 2 without new proof, is demoted to
  // advisory + persistent-unproven and the verdict unblocks. Proven blockers immune.
  const wrongBlocker = { lens: "security", file: "src/x.ts", line: 42, severity: "must-fix", finding: "regex $ matches before a trailing newline" };
  const refutation = { reviewer: "codex" as const, file: "src/x.ts", line: 42, lens: "security", finding: wrongBlocker.finding, evidence: "node -e 'process.stdout.write(String(/x$/.test(\"x\\n\")))' prints false; CI green" };

  test("#213 replay: round-2 unproven repeat is demoted to advisory + persistent-unproven, verdict unblocks (AC1)", async () => {
    const claude = scripted([[], []]); // claude approves both rounds
    const codex = scripted([[wrongBlocker], [wrongBlocker]]); // codex re-raises the SAME wrong blocker, no repro
    const { store } = memStore();
    const d = deps(claude.backend, codex.backend, store);

    // Round 1 — no refutation yet: the unproven blocker is accepted and blocks.
    const r1 = await runReview({ session: "s213" }, d);
    expect(r1.verdict).toBe("block");
    expect(r1.must_fix.map((m) => m.finding)).toContain(wrongBlocker.finding);

    // Round 2 — the worker refutes it with a counter-repro; codex re-raises without
    // new proof → demoted to advisory + tagged, and the verdict unblocks.
    const r2 = await runReview({ session: "s213", refutations: [refutation] }, d);
    expect(r2.verdict).toBe("approve"); // unblocked (never auto-approved: no genuine blocker remained)
    expect(r2.must_fix).toHaveLength(0);
    const demoted = r2.nice_fix.find((f) => f.finding === wrongBlocker.finding);
    expect(demoted).toBeDefined(); // demoted, NOT deleted — still visible
    expect(demoted!.persistentUnproven?.codex).toBe(true);

    // AC3: the ledger was shown to codex's round-2 prompt (evidence + warning).
    expect(codex.prompts[1]).toContain("REFUTED");
    expect(codex.prompts[1]).toContain("persistent-unproven");
    expect(codex.prompts[1]).toContain("CI green");
  });

  test("#101 AC2: a re-raised blocker that now carries a repro is NOT demoted (proven blocker immune)", async () => {
    const provenBlocker = { ...wrongBlocker, repro: "node -e 'assert(bug)'" };
    const claude = scripted([[], []]);
    const codex = scripted([[wrongBlocker], [provenBlocker]]); // round 2 supplies proof
    const { store } = memStore();
    const d = deps(claude.backend, codex.backend, store);

    await runReview({ session: "sproof" }, d); // round 1 blocks
    const r2 = await runReview({ session: "sproof", refutations: [refutation] }, d);
    // The blocker now carries a repro, so it survives refutation and still blocks.
    expect(r2.verdict).toBe("block");
    expect(r2.must_fix.map((m) => m.finding)).toContain(wrongBlocker.finding);
  });

  test("#101: a refutation-demoted finding does NOT become sticky, so a later PROVEN re-raise still blocks", async () => {
    // Round 1 unproven blocker → block; round 2 refuted + no repro → demoted →
    // approve; round 3 re-raised WITH a repro must stay a must-fix (proven blocker
    // immune). Regression guard: if the demoted finding wrongly became sticky, the
    // sticky guard (runs before the ledger, ignores repro) would demote it round 3.
    const provenBlocker = { ...wrongBlocker, repro: "node -e 'assert(realBug)'" };
    const claude = scripted([[], [], []]);
    const codex = scripted([[wrongBlocker], [wrongBlocker], [provenBlocker]]);
    const { store } = memStore();
    const d = deps(claude.backend, codex.backend, store);

    expect((await runReview({ session: "sfix" }, d)).verdict).toBe("block");
    expect((await runReview({ session: "sfix", refutations: [refutation] }, d)).verdict).toBe("approve");
    const r3 = await runReview({ session: "sfix" }, d);
    expect(r3.verdict).toBe("block"); // proven blocker is immune — not sticky-demoted
    expect(r3.must_fix.map((m) => m.finding)).toContain(wrongBlocker.finding);
  });

  test("#101: a one-shot review does not demote a matching blocker (accepted in round 1; ledger is session-scoped)", async () => {
    // Even if refutations are somehow supplied without a session, a first pass must
    // accept the blocker (the pipeline ignores the one-shot ledger).
    const claude = scripted([[]]);
    const codex = scripted([[wrongBlocker]]);
    const { store } = memStore();
    const r = await runReview({ refutations: [refutation] }, deps(claude.backend, codex.backend, store));
    expect(r.verdict).toBe("block"); // accepted, not demoted
  });

  test("#101 AC3: the ledger is persisted per-leg in the session state", async () => {
    const claude = scripted([[wrongBlocker]]);
    const codex = scripted([[wrongBlocker]]);
    const { store, data } = memStore();
    await runReview({ session: "sledger", refutations: [refutation] }, deps(claude.backend, codex.backend, store));
    const saved = data.get("sledger");
    expect(saved?.ledger?.codex).toHaveLength(1);
    expect(saved?.ledger?.codex[0]?.evidence).toContain("CI green");
    expect(saved?.ledger?.claude).toHaveLength(0); // refutation was scoped to codex only
  });

  test("a pre-#100 session state (round absent → loaded as 0) makes the next re-review round 1", async () => {
    const claude = scripted([[]]);
    const codex = scripted([[]]);
    const { store, data } = memStore();
    // Seed a state as an older build would (no round field on the object).
    data.set("sold", {
      version: 1,
      results: { claude: { reviewer: "claude", verdict: "approve", findings: [] }, codex: { reviewer: "codex", verdict: "approve", findings: [] } },
      sticky: { claude: [], codex: [] },
    } as SessionState);
    const r = await runReview({ session: "sold" }, deps(claude.backend, codex.backend, store));
    expect(r.round).toBe(1);
  });

  // The #91 merge gate: a two-round --session re-review where round 1 blocks on a
  // must-fix, the worker fixes it, and round 2 with the same session must NOT
  // re-raise the resolved finding — and each leg is verifiably fed its prior
  // finding (the mechanism the fix introduces).
  test("two-round --session re-review: prior finding is threaded in, and a resolved must-fix is not re-raised", async () => {
    const bug = { lens: "correctness", file: "app.ts", line: 10, severity: "must-fix", finding: "unbounded loop" };
    const claude = scripted([[bug], []]); // round 1 flags it; round 2 (fixed) is clean
    const codex = scripted([[bug], []]);
    const { store } = memStore();
    const d = deps(claude.backend, codex.backend, store);

    // Round 1 — first round, no prior context yet → blocks.
    const r1 = await runReview({ session: "s1" }, d);
    expect(r1.verdict).toBe("block");
    expect(r1.must_fix.map((m) => m.finding)).toContain("unbounded loop");
    expect(claude.prompts[0]).not.toContain("In the previous round");

    // Round 2 — the prior finding is now threaded into EACH leg's prompt...
    const r2 = await runReview({ session: "s1" }, d);
    expect(claude.prompts[1]).toContain("unbounded loop");
    expect(claude.prompts[1]).toContain("still visible in the current diff");
    expect(codex.prompts[1]).toContain("unbounded loop");
    // ...and, resolved, it is not re-raised: the leg reviews incrementally.
    expect(r2.verdict).toBe("approve");
    expect(r2.must_fix).toHaveLength(0);
  });

  // Legs stay independent: each leg's round-2 prompt must carry ONLY its own
  // prior findings, never the other leg's — a swapped or broadcast threading
  // (the bug this asserts against) would fail here.
  test("re-review threads each leg ONLY its own prior findings (no cross-leg leakage)", async () => {
    const claudeBug = { lens: "correctness", file: "c.ts", line: 1, severity: "must-fix", finding: "claude-only defect" };
    const codexBug = { lens: "security", file: "k.ts", line: 2, severity: "must-fix", finding: "codex-only defect" };
    const claude = scripted([[claudeBug], []]);
    const codex = scripted([[codexBug], []]);
    const { store } = memStore();
    const d = deps(claude.backend, codex.backend, store);

    await runReview({ session: "sIndep" }, d); // round 1: each leg finds its own distinct bug
    await runReview({ session: "sIndep" }, d); // round 2: prior findings threaded per-leg

    expect(claude.prompts[1]).toContain("claude-only defect");
    expect(claude.prompts[1]).not.toContain("codex-only defect");
    expect(codex.prompts[1]).toContain("codex-only defect");
    expect(codex.prompts[1]).not.toContain("claude-only defect");
  });

  test("sticky-approve: an approving leg is not flipped to block by an escalated prior finding", async () => {
    const nit = { lens: "clarity", file: "x.ts", line: 3, finding: "rename foo" };
    const claude = scripted([[{ ...nit, severity: "nit" }], [{ ...nit, severity: "must-fix" }]]);
    const codex = scripted([[], []]);
    const { store } = memStore();
    const d = deps(claude.backend, codex.backend, store);

    const r1 = await runReview({ session: "s2" }, d);
    expect(r1.verdict).toBe("approve");

    // Round 2 tries to escalate the same finding to must-fix; the guard demotes it.
    const r2 = await runReview({ session: "s2" }, d);
    expect(r2.verdict).toBe("approve");
    expect(r2.must_fix).toHaveLength(0);
    expect(r2.nice_fix.map((n) => n.finding)).toContain("rename foo");
  });

  // The multi-round oscillation gap: a point a leg approved-with (nit A) must not
  // be revived as a blocker two rounds later — even across an intervening block
  // round on an unrelated new must-fix (B) — after B is fixed.
  test("sticky-approve holds across an intervening block round (multi-round)", async () => {
    const a = { lens: "clarity", file: "x.ts", line: 3, finding: "subjective naming" };
    const b = { lens: "correctness", file: "y.ts", line: 8, severity: "must-fix", finding: "real bug B" };
    const claude = scripted([
      [{ ...a, severity: "nit" }], // round 1: approve with nit A
      [{ ...a, severity: "nit" }, b], // round 2: A still a nit + NEW must-fix B → block
      [{ ...a, severity: "must-fix" }], // round 3: B fixed, A spuriously escalated to must-fix
    ]);
    const codex = scripted([[], [], []]);
    const { store } = memStore();
    const d = deps(claude.backend, codex.backend, store);

    expect((await runReview({ session: "sMulti" }, d)).verdict).toBe("approve"); // r1
    const r2 = await runReview({ session: "sMulti" }, d);
    expect(r2.verdict).toBe("block");
    expect(r2.must_fix.map((m) => m.finding)).toContain("real bug B");

    const r3 = await runReview({ session: "sMulti" }, d);
    expect(r3.verdict).toBe("approve"); // A was accepted in r1 → its escalation is demoted
    expect(r3.must_fix).toHaveLength(0);
    expect(r3.nice_fix.map((n) => n.finding)).toContain("subjective naming");
  });

  test("no weakening: a genuinely new must-fix still blocks after an approval", async () => {
    const claude = scripted([[], [{ lens: "security", file: "y.ts", line: 5, severity: "must-fix", finding: "new sqli" }]]);
    const codex = scripted([[], []]);
    const { store } = memStore();
    const d = deps(claude.backend, codex.backend, store);

    await runReview({ session: "s3" }, d); // round 1: approve
    const r2 = await runReview({ session: "s3" }, d);
    expect(r2.verdict).toBe("block");
    expect(r2.must_fix.map((m) => m.finding)).toContain("new sqli");
  });

  test("the default (no --session) path threads no prior findings and persists nothing", async () => {
    const claude = scripted([[]]);
    const codex = scripted([[]]);
    const { store, data } = memStore();
    const d = deps(claude.backend, codex.backend, store);

    await runReview({}, d);
    expect(claude.prompts[0]).not.toContain("In the previous round");
    expect(data.size).toBe(0);
  });
});
