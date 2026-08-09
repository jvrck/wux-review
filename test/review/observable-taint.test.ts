import { describe, expect, test } from "bun:test";
import {
  runObservableLeg,
  type ObservableAdapterDeps,
  type ObservableLegInput,
} from "../../src/backends/observable";

const REPORT = '```json\n{"findings":[]}\n```';
const STREAM = JSON.stringify({
  type: "result",
  subtype: "success",
  is_error: false,
  result: REPORT,
});

function taintHarness(options: {
  event?: { type: string; by?: string; at?: string };
  events?: { type: string; by?: string; at?: string }[];
  afterResult?: boolean;
} = {}) {
  const files = new Map<string, string>();
  const calls: string[][] = [];
  const childName = "taint-review-r1-claude";
  const runDir = `/evidence/${childName}`;
  const base = `/tmp/taint/${childName}`;
  let live = false;
  let injected = false;
  const inject = () => {
    const events = options.events ?? (options.event === undefined ? [] : [options.event]);
    if (injected || events.length === 0) return;
    injected = true;
    files.set(
      `${runDir}/events.jsonl`,
      `${files.get(`${runDir}/events.jsonl`) ?? ""}${events.map((event) =>
        JSON.stringify({
          ...event,
          at: event.at ?? "2026-07-28T01:02:04Z",
          run: childName,
        })).join("\n")}\n`,
    );
  };
  const deps: Partial<ObservableAdapterDeps> = {
    run: async (cmd, opts) => {
      calls.push(cmd);
      if (cmd.includes("status")) {
        return { code: 0, stdout: "[]", stderr: "", timedOut: false };
      }
      if (cmd.includes("run")) {
        live = true;
        files.set(
          `${runDir}/events.jsonl`,
          `${JSON.stringify({ type: "create", at: "2026-07-28T01:02:03Z", run: childName })}\n`,
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
          : { code: 1, stdout: "", stderr: "tmux session is not running", timedOut: false };
      }
      if (cmd.includes("stop")) {
        live = false;
        files.set(
          `${runDir}/events.jsonl`,
          `${files.get(`${runDir}/events.jsonl`) ?? ""}${JSON.stringify({
            type: "stop",
            at: "2026-07-28T01:02:06Z",
            run: childName,
            by: opts.env?.USER === undefined
              ? "worker@host"
              : `${opts.env.USER}@host`,
          })}\n`,
        );
        return { code: 0, stdout: "", stderr: "", timedOut: false };
      }
      throw new Error(cmd.join(" "));
    },
    mkdir: async () => {},
    rm: async (path) => void files.delete(path),
    writeFile: async (path, content) => {
      files.set(path, content);
      if (path.endsWith("-observable-ready")) {
        files.set(`${base}-observable-stdout`, STREAM);
        files.set(`${base}-observable-stderr`, "");
        files.set(`${base}-observable-done`, "0");
        if (!options.afterResult) inject();
      }
      const releaseMarker = "-observable-release-";
      const releaseIndex = path.indexOf(releaseMarker);
      if (releaseIndex !== -1) {
        const generation = path.slice(releaseIndex + releaseMarker.length);
        files.set(
          `${base}-observable-released-${generation}`,
          content.trim(),
        );
        live = false;
      }
    },
    writePrivateFile: async (path, content) => {
      if (files.has(path)) throw new Error("exclusive collision");
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
      if (options.afterResult && to.endsWith("/result.json")) inject();
    },
    sleep: async () => {},
    now: () => "2026-07-28T01:02:05Z",
    resultId: () => "result-taint",
    tmpDir: "/tmp/taint",
    pollIntervalMs: 1,
  };
  const input: ObservableLegInput = {
    childName,
    reviewId: "taint-review",
    round: 1,
    reviewer: "claude",
    attempt: 1,
    prompt: "PROMPT",
    argv: ["claude", "-p"],
    stdin: "PROMPT",
    cwd: "/repo",
    timeoutMs: 10,
  };
  return { deps, input, files, calls, runDir, childName };
}

describe("observable external-control taint", () => {
  test("read/view/attach observation is harmless and never taints", async () => {
    const h = taintHarness({
      events: [
        { type: "read", at: "2026-07-28T01:02:04Z" },
        { type: "view", at: "2026-07-28T01:02:04Z" },
        { type: "status", at: "2026-07-28T01:02:04Z" },
        { type: "attach", at: "2026-07-28T01:02:04Z" },
      ],
    });
    await expect(runObservableLeg(h.input, h.deps)).resolves.toMatchObject({ code: 0 });
    expect(JSON.parse(h.files.get(`${h.runDir}/lifecycle.json`)!).state).toBe("completed");
    expect(h.files.get(`${h.runDir}/events.jsonl`)).not.toContain("review-leg-tainted");
  });

  for (const action of ["send", "interrupt", "stop"] as const) {
    test(`external ${action} records actor/time/action, taints, and fails closed`, async () => {
      const h = taintHarness({
        event: {
          type: action,
          by: "mcp:operator-console",
          at: "2026-07-28T01:02:04Z",
        },
      });
      await expect(runObservableLeg(h.input, h.deps)).rejects.toThrow(
        `tainted by external ${action} from mcp:operator-console at 2026-07-28T01:02:04Z`,
      );
      const lifecycle = JSON.parse(h.files.get(`${h.runDir}/lifecycle.json`)!);
      expect(lifecycle).toMatchObject({
        state: "tainted",
        controls: [{
          action,
          actor: "mcp:operator-console",
          at: "2026-07-28T01:02:04Z",
        }],
      });
      expect(h.calls.some((cmd) => cmd.join(" ") ===
        `wux --local stop ${h.childName} --yes`)).toBe(true);
    });
  }

  test("handoff's released send actor taints even though the later summary event has no actor", async () => {
    const h = taintHarness({
      events: [
        { type: "send", by: "operator@host", at: "2026-07-28T01:02:04Z" },
        { type: "handoff" },
      ],
    });
    await expect(runObservableLeg(h.input, h.deps)).rejects.toThrow(
      "tainted by external send from operator@host",
    );
    const lifecycle = JSON.parse(h.files.get(`${h.runDir}/lifecycle.json`)!);
    expect(lifecycle.controls).toEqual([
      {
        action: "send",
        actor: "operator@host",
        at: "2026-07-28T01:02:04Z",
      },
      {
        action: "handoff",
        actor: "operator@host",
        at: "2026-07-28T01:02:04Z",
      },
    ]);
  });

  test("a truncated released event log taints instead of being ignored", async () => {
    const h = taintHarness();
    const originalRename = h.deps.rename!;
    h.deps.rename = async (from, to) => {
      await originalRename(from, to);
      if (to.endsWith("/result.json")) {
        h.files.set(`${h.runDir}/events.jsonl`, '{"type":"send"');
      }
    };
    await expect(runObservableLeg(h.input, h.deps)).rejects.toThrow(
      "tainted by malformed or rewritten Wux event evidence",
    );
    expect(JSON.parse(h.files.get(`${h.runDir}/lifecycle.json`)!).controls)
      .toContainEqual({
        action: "invalid-events",
        actor: "unknown",
        at: "2026-07-28T01:02:05Z",
      });
  });

  test("a same-length rewrite of the already-scanned event prefix taints", async () => {
    const h = taintHarness();
    const originalRename = h.deps.rename!;
    h.deps.rename = async (from, to) => {
      await originalRename(from, to);
      if (to.endsWith("/result.json")) {
        const path = `${h.runDir}/events.jsonl`;
        h.files.set(
          path,
          h.files.get(path)!.replace("review-leg-start", "review-leg-stert"),
        );
      }
    };
    await expect(runObservableLeg(h.input, h.deps)).rejects.toThrow(
      "tainted by malformed or rewritten Wux event evidence",
    );
    expect(JSON.parse(h.files.get(`${h.runDir}/lifecycle.json`)!).state)
      .toBe("tainted");
  });

  test("a mutation after atomic result publication still blocks acceptance", async () => {
    const h = taintHarness({
      event: { type: "send", by: "late@host", at: "2026-07-28T01:02:05Z" },
      afterResult: true,
    });
    await expect(runObservableLeg(h.input, h.deps)).rejects.toThrow(
      "tainted by external send from late@host",
    );
    expect(h.files.has(`${h.runDir}/result.json`)).toBe(true);
    expect(JSON.parse(h.files.get(`${h.runDir}/lifecycle.json`)!).state).toBe("tainted");
  });
});
