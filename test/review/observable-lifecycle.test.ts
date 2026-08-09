import { describe, expect, test } from "bun:test";
import {
  runObservableLeg,
  type ObservableAdapterDeps,
  type ObservableLegInput,
  type ObservableRunOptions,
} from "../../src/backends/observable";

const REPORT = '```json\n{"findings":[]}\n```';
const STREAM = JSON.stringify({
  type: "result",
  subtype: "success",
  is_error: false,
  result: REPORT,
});

function lifecycleHarness(options: {
  complete?: boolean;
  disappear?: boolean;
  code?: number;
  abortOnEvidence?: AbortController;
  abortReason?: "parent-interrupted" | "sibling-failed";
} = {}) {
  const files = new Map<string, string>();
  const calls: { cmd: string[]; opts: ObservableRunOptions }[] = [];
  const childName = "life-review-r1-claude";
  const runDir = `/evidence/${childName}`;
  const tmpDir = "/tmp/lifecycle";
  let live = false;
  const deps: Partial<ObservableAdapterDeps> = {
    run: async (cmd, opts) => {
      calls.push({ cmd, opts });
      if (cmd.includes("status")) {
        return { code: 0, stdout: "[]", stderr: "", timedOut: false };
      }
      if (cmd.includes("run")) {
        live = true;
        files.set(
          `${runDir}/events.jsonl`,
          `${JSON.stringify({ type: "create", at: "2026-07-28T00:00:00Z", run: childName })}\n`,
        );
        return {
          code: 0,
          stdout: JSON.stringify({ name: childName, backend: "shell" }),
          stderr: "",
          timedOut: false,
        };
      }
      if (cmd.includes("read")) {
        return live
          ? {
              code: 0,
              stdout: JSON.stringify({ name: childName, runDir, lines: [] }),
              stderr: "",
              timedOut: false,
            }
          : {
              code: 1,
              stdout: "",
              stderr: "tmux session is not running",
              timedOut: false,
            };
      }
      if (cmd.includes("stop")) {
        live = false;
        files.set(
          `${runDir}/events.jsonl`,
          `${files.get(`${runDir}/events.jsonl`) ?? ""}${JSON.stringify({
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
      throw new Error(`unexpected command: ${cmd.join(" ")}`);
    },
    mkdir: async () => {},
    rm: async (path) => void files.delete(path),
    writeFile: async (path, content) => {
      files.set(path, content);
      if (path.endsWith("-observable-ready")) {
        if (options.complete !== false) {
          const stem = path.slice(0, -"-observable-ready".length);
          files.set(`${stem}-observable-stdout`, STREAM);
          files.set(`${stem}-observable-stderr`, "");
          files.set(`${stem}-observable-done`, String(options.code ?? 0));
        }
        if (options.disappear) live = false;
      }
      const releaseMarker = "-observable-release-";
      const releaseIndex = path.indexOf(releaseMarker);
      if (releaseIndex !== -1) {
        const stem = path.slice(0, releaseIndex);
        const generation = path.slice(releaseIndex + releaseMarker.length);
        files.set(
          `${stem}-observable-released-${generation}`,
          content.trim(),
        );
        live = false;
      }
    },
    writePrivateFile: async (path, content) => {
      if (files.has(path)) throw new Error("exclusive write collision");
      files.set(path, content);
    },
    readFile: async (path) => files.get(path),
    snapshotSize: async (path) => {
      const raw = files.get(path);
      return raw === undefined ? undefined : Buffer.byteLength(raw);
    },
    readChunk: async (path, offset, maxBytes) =>
      Buffer.from(files.get(path) ?? "").subarray(offset, offset + maxBytes),
    appendFile: async (path, content) =>
      void files.set(path, `${files.get(path) ?? ""}${content}`),
    rename: async (from, to) => {
      const raw = files.get(from);
      if (raw === undefined) throw new Error(`missing ${from}`);
      files.set(to, raw);
      files.delete(from);
    },
    sleep: async () => {},
    now: () => "2026-07-28T00:00:02Z",
    resultId: () => "result-life",
    tmpDir,
    pollIntervalMs: 1,
  };
  const input: ObservableLegInput = {
    childName,
    reviewId: "life-review",
    round: 1,
    reviewer: "claude",
    attempt: 1,
    prompt: "PROMPT",
    argv: ["claude", "-p"],
    stdin: "PROMPT",
    cwd: "/repo",
    timeoutMs: 2,
    signal: options.abortOnEvidence?.signal,
    recordEvidence: () => options.abortOnEvidence?.abort(
      options.abortReason ?? "parent-interrupted",
    ),
  };
  return { deps, input, files, calls, runDir, tmpDir, childName };
}

describe("observable leg lifecycle", () => {
  test("a pre-aborted signal performs no filesystem or Wux/model launch", async () => {
    const abort = new AbortController();
    abort.abort("parent-interrupted");
    const h = lifecycleHarness();
    await expect(runObservableLeg(
      { ...h.input, signal: abort.signal },
      h.deps,
    )).rejects.toThrow("interrupted before launch");
    expect(h.calls).toHaveLength(0);
    expect(h.files.size).toBe(0);
  });

  test("persists typed pending/running/completed transitions and reaps only its child", async () => {
    const h = lifecycleHarness();
    await expect(runObservableLeg(h.input, h.deps)).resolves.toMatchObject({
      code: 0,
      timedOut: false,
    });
    const lifecycle = JSON.parse(h.files.get(`${h.runDir}/lifecycle.json`)!);
    expect(lifecycle.state).toBe("completed");
    const transitions = h.files.get(`${h.runDir}/events.jsonl`)!
      .trimEnd()
      .split("\n")
      .map((line) => JSON.parse(line))
      .filter((event) => event.type === "review-leg-lifecycle")
      .map((event) => event.state);
    expect(transitions).toEqual(["pending", "running", "completed"]);
    expect(h.calls.filter((call) => call.cmd.includes("stop")).map((call) => call.cmd))
      .toEqual([["wux", "--local", "stop", h.childName, "--yes"]]);
    expect([...h.files.keys()].filter((path) =>
      path.startsWith(`${h.tmpDir}/${h.childName}`)
    )).toEqual([]);
  });

  test("child disappearance fails closed with evidence and removes all transients", async () => {
    const h = lifecycleHarness({ complete: false, disappear: true });
    h.deps.pollIntervalMs = 5_000;
    await expect(runObservableLeg({ ...h.input, timeoutMs: 10_000 }, h.deps)).rejects.toThrow(
      `child disappeared before publishing a process result; evidence: ${h.runDir}`,
    );
    expect(JSON.parse(h.files.get(`${h.runDir}/lifecycle.json`)!).state).toBe("failed");
    expect(h.files.has(`${h.runDir}/result.json`)).toBe(false);
    expect([...h.files.keys()].some((path) => path.startsWith(`${h.tmpDir}/${h.childName}`)))
      .toBe(false);
  });

  test("timeout is durable, exact-targeted, and leaves no result or transient", async () => {
    const h = lifecycleHarness({ complete: false });
    const result = await runObservableLeg({ ...h.input, timeoutMs: 0 }, h.deps);
    expect(result.timedOut).toBe(true);
    expect(JSON.parse(h.files.get(`${h.runDir}/lifecycle.json`)!).state).toBe("timed_out");
    expect(h.files.has(`${h.runDir}/result.json`)).toBe(false);
    expect(h.calls.some((call) => call.cmd.join(" ") ===
      `wux --local stop ${h.childName} --yes`)).toBe(true);
    expect([...h.files.keys()].some((path) => path.startsWith(`${h.tmpDir}/${h.childName}`)))
      .toBe(false);
  });

  test("a non-zero reviewer exit is durable failure evidence before the caller rejects it", async () => {
    const h = lifecycleHarness({ code: 7 });
    await expect(runObservableLeg(h.input, h.deps)).resolves.toMatchObject({
      code: 7,
      timedOut: false,
    });
    expect(JSON.parse(h.files.get(`${h.runDir}/lifecycle.json`)!)).toMatchObject({
      state: "failed",
      diagnostic: "reviewer process exited 7",
    });
    expect(JSON.parse(h.files.get(`${h.runDir}/status.json`)!)).toMatchObject({
      status: "failed",
      result: { state: "final", code: 7 },
    });
  });

  test("parent interruption preserves the exact child/bootstrap for zero-call reconciliation", async () => {
    const abort = new AbortController();
    const h = lifecycleHarness({ complete: false, abortOnEvidence: abort });
    await expect(runObservableLeg(h.input, h.deps)).rejects.toThrow(
      "reconcile review life-review",
    );
    expect(JSON.parse(h.files.get(`${h.runDir}/lifecycle.json`)!).state).toBe("interrupted");
    expect(h.calls.some((call) => call.cmd.includes("stop"))).toBe(false);
    expect(h.files.has(`${h.tmpDir}/${h.childName}-observable-args`)).toBe(true);
    expect(h.files.has(`${h.runDir}/result.json`)).toBe(false);
  });

  test("sibling cancellation fails durably and reaps only the cancelled child", async () => {
    const abort = new AbortController();
    const h = lifecycleHarness({
      complete: false,
      abortOnEvidence: abort,
      abortReason: "sibling-failed",
    });
    await expect(runObservableLeg(h.input, h.deps)).rejects.toThrow(
      "cancelled after its sibling failed",
    );
    expect(JSON.parse(h.files.get(`${h.runDir}/lifecycle.json`)!).state).toBe("failed");
    expect(h.calls.filter((call) => call.cmd.includes("stop")).map((call) => call.cmd))
      .toEqual([["wux", "--local", "stop", h.childName, "--yes"]]);
    expect([...h.files.keys()].some((path) => path.startsWith(`${h.tmpDir}/${h.childName}`)))
      .toBe(false);
  });
});
