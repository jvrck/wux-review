import { describe, expect, test } from "bun:test";
import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  defaultObservableDeps,
  discardObservableLeg,
  discardPreparedObservableLeg,
  OBSERVABLE_DRAIN_READS_PER_PASS,
  ObservableLifecycleError,
  runObservableLeg,
  scheduleFileRemoval,
  type ObservableAdapterDeps,
  type ObservableLegInput,
  type ObservableRunOptions,
} from "../../src/backends/observable";
import { REVIEWER_STDERR_TAIL_BYTES } from "../../src/backends/capture-limits";
import {
  MACHINE_EVENT_READ_CHUNK_BYTES,
} from "../../src/backends/observable-events";

const REPORT = '```json\n{"findings":[]}\n```';
const CLAUDE_STREAM = JSON.stringify({
  type: "result",
  subtype: "success",
  is_error: false,
  result: REPORT,
});

interface HarnessOptions {
  existing?: string[];
  statusJson?: string;
  resultId?: string;
  launchJson?: string;
  readJson?: string;
  complete?: boolean;
  code?: number;
  stdout?: string;
  stderr?: string;
  structuredOutput?: string;
  corruptResult?: boolean;
  hideResult?: boolean;
  wrapperStatus?: "running" | "stopped";
  preexistingResult?: boolean;
  stopError?: string;
  stopTimesOutAfterEvent?: boolean;
  omitStopEvent?: boolean;
  omitReleaseAck?: boolean;
  readGoneJson?: boolean;
  failTransientCleanup?: boolean;
  releaseLingerReads?: number;
}

function harness(options: HarnessOptions = {}) {
  const files = new Map<string, string>();
  const calls: { cmd: string[]; opts: ObservableRunOptions }[] = [];
  const renames: Array<[string, string]> = [];
  const privateWrites: string[] = [];
  const appends: Array<{ path: string; content: string }> = [];
  const scheduledRms: Array<{ path: string; delayMs: number }> = [];
  const releaseLifecycle: string[] = [];
  const lifecycleStates: string[] = [];
  const sleeps: number[] = [];
  const childName = "obs-review-r2-claude";
  const runDir = `/evidence/${childName}`;
  const tmpDir = "/tmp/observable-test";
  const outputPath = `${tmpDir}/${childName}-last.txt`;
  let launched = false;
  let live = false;
  let transientCleanupFailed = false;
  let releasedBootstrapRemoved = false;
  let releaseLingerReads = options.releaseLingerReads ?? 0;

  const deps: Partial<ObservableAdapterDeps> = {
    run: async (cmd, opts) => {
      calls.push({ cmd, opts });
      if (cmd.includes("status")) {
        const runs = launched
          ? [{
              name: childName,
              status: options.wrapperStatus ?? "running",
            }]
          : (options.existing ?? []).map((name) => ({
              name,
              status: "running",
            }));
        return {
          code: 0,
          stdout: options.statusJson ?? JSON.stringify(runs),
          stderr: "",
          timedOut: false,
        };
      }
      if (cmd.includes("run")) {
        launched = true;
        live = true;
        files.set(
          `${runDir}/events.jsonl`,
          `${JSON.stringify({
            type: "create",
            at: "2026-07-28T01:02:02Z",
            run: childName,
            backend: "shell",
          })}\n`,
        );
        return {
          code: 0,
          stdout: options.launchJson ?? JSON.stringify({ name: childName, backend: "shell" }),
          stderr: "",
          timedOut: false,
        };
      }
      if (cmd.includes("read")) {
        if (!live) {
          if (options.readGoneJson) {
            return {
              code: 1,
              stdout: JSON.stringify({
                error: {
                  code: "wux-error",
                  message: `run is stopped: ${childName}`,
                },
              }),
              stderr: "",
              timedOut: false,
            };
          }
          return {
            code: 1,
            stdout: "",
            stderr: "wux: tmux session is not running",
            timedOut: false,
          };
        }
        if (releasedBootstrapRemoved && releaseLingerReads > 0) {
          releaseLingerReads--;
          if (releaseLingerReads === 0) live = false;
        }
        return {
          code: 0,
          stdout: options.readJson ?? JSON.stringify({ name: childName, runDir, lines: [] }),
          stderr: "",
          timedOut: false,
        };
      }
      if (cmd.includes("stop")) {
        live = false;
        if (options.stopError !== undefined) {
          return {
            code: 1,
            stdout: "",
            stderr: options.stopError,
            timedOut: false,
          };
        }
        if (!options.omitStopEvent) {
          files.set(
            `${runDir}/events.jsonl`,
            `${files.get(`${runDir}/events.jsonl`) ?? ""}${JSON.stringify({
              type: "stop",
              at: "2026-07-28T01:02:04Z",
              run: childName,
              // Exercise the released Wux fallback as well as its USER-first path:
              // production sets both actor inputs to the same nonce.
              by: opts.env?.LOGNAME === undefined
                ? "test@host"
                : `${opts.env.LOGNAME}@host`,
            })}\n`,
          );
        }
        if (options.stopTimesOutAfterEvent) {
          return { code: null, stdout: "", stderr: "", timedOut: true };
        }
        return { code: 0, stdout: "", stderr: "", timedOut: false };
      }
      throw new Error(`unexpected command: ${cmd.join(" ")}`);
    },
    mkdir: async () => {},
    writePrivateFile: async (path, content) => {
      privateWrites.push(path);
      files.set(path, content);
    },
    rm: async (path) => {
      if (
        options.failTransientCleanup
        && !transientCleanupFailed
        && launched
        && path.startsWith(`${tmpDir}/${childName}`)
      ) {
        transientCleanupFailed = true;
        throw new Error("EPERM removing transient args");
      }
      if (
        launched
        && !releasedBootstrapRemoved
        && path === `${tmpDir}/${childName}-observable-args`
      ) {
        releasedBootstrapRemoved = true;
        releaseLifecycle.push("bootstrap-removed");
        if (options.releaseLingerReads === undefined) live = false;
      }
      files.delete(path);
    },
    writeFile: async (path, content) => {
      if (path.includes("-observable-release-")) {
        releaseLifecycle.push("publish");
      }
      files.set(path, content);
      if (path.includes("-observable-release-") && !options.omitReleaseAck) {
        files.set(
          path.replace("-observable-release-", "-observable-released-"),
          content.trim(),
        );
      }
      if (path.endsWith("-observable-ready") && options.complete !== false) {
        const stem = path.slice(0, -"-observable-ready".length);
        files.set(`${stem}-observable-stdout`, options.stdout ?? CLAUDE_STREAM);
        files.set(`${stem}-observable-stderr`, options.stderr ?? "");
        files.set(`${stem}-observable-done`, String(options.code ?? 0));
        if (options.structuredOutput !== undefined) {
          files.set(outputPath, options.structuredOutput);
        }
        if (options.preexistingResult) {
          files.set(`${runDir}/result.json`, '{"version":1,"replayed":true}\n');
        }
      }
    },
    readFile: async (path) => {
      if (options.hideResult && path.endsWith("/result.json")) return undefined;
      return files.get(path);
    },
    snapshotSize: async (path) => {
      const raw = files.get(path);
      return raw === undefined ? undefined : Buffer.byteLength(raw);
    },
    readChunk: async (path, offset, maxBytes) => {
      const bytes = Buffer.from(files.get(path) ?? "");
      return bytes.subarray(offset, offset + maxBytes);
    },
    appendFile: async (path, content) => {
      appends.push({ path, content });
      files.set(path, `${files.get(path) ?? ""}${content}`);
    },
    rename: async (from, to) => {
      renames.push([from, to]);
      const content = files.get(from);
      if (content === undefined) throw new Error(`missing rename source: ${from}`);
      if (to.endsWith("/lifecycle.json")) {
        lifecycleStates.push(JSON.parse(content).state);
      }
      files.set(to, options.corruptResult && to.endsWith("/result.json") ? "{bad" : content);
      files.delete(from);
    },
    sleep: async (ms) => {
      sleeps.push(ms);
    },
    scheduleRm: (path, delayMs) => {
      if (path.includes("-observable-release-")) {
        releaseLifecycle.push("schedule");
      }
      scheduledRms.push({ path, delayMs });
    },
    now: () => "2026-07-28T01:02:03Z",
    resultId: () => options.resultId ?? "result-identity",
    tmpDir,
    pollIntervalMs: 1,
  };

  const input: ObservableLegInput = {
    childName,
    reviewId: "review",
    round: 2,
    reviewer: "claude",
    attempt: 1,
    prompt: "PROMPT BYTES",
    argv: ["claude", "-p", "--output-format", "stream-json", "--verbose", "--model", "model with spaces;$(nope)"],
    stdin: "PROMPT BYTES",
    cwd: "/repo",
    timeoutMs: 5,
  };
  return {
    deps,
    input,
    files,
    calls,
    renames,
    privateWrites,
    appends,
    scheduledRms,
    releaseLifecycle,
    lifecycleStates,
    sleeps,
    runDir,
    outputPath,
  };
}

describe("runObservableLeg", () => {
  test("legacy keyless cleanup never stops a live run that reused the child name", async () => {
    const childName = "obs-review-r2-claude";
    const evidencePath = `/evidence/old/${childName}`;
    const transientBase = `/tmp/observable-test/${childName}`;
    const calls: string[][] = [];
    await expect(discardObservableLeg({
      reviewId: "review",
      round: 2,
      evidence: {
        reviewer: "claude",
        childName,
        attempt: 1,
        evidencePath,
        resultPath: `${evidencePath}/result.json`,
        resultId: "legacy-result",
        promptSha256: "a".repeat(64),
        transientBase,
      },
    }, {
      tmpDir: "/tmp/observable-test",
      run: async (cmd) => {
        calls.push(cmd);
        return {
          code: 0,
          stdout: `${JSON.stringify({
            name: childName,
            runDir: `/evidence/new/${childName}`,
          })}\n`,
          stderr: "",
          timedOut: false,
        };
      },
    })).rejects.toThrow("Wux liveness identity changed");
    expect(calls).toHaveLength(1);
    expect(calls[0]).toContain("read");
    expect(calls[0]).not.toContain("stop");
  });

  test("legacy keyless cleanup removes transients only after proving the child absent", async () => {
    const childName = "obs-review-r2-claude";
    const evidencePath = `/evidence/${childName}`;
    const transientBase = `/tmp/observable-test/${childName}`;
    const resultTmp = `${evidencePath}/result.json.tmp`;
    const argsPath = `${transientBase}-observable-args`;
    const files = new Map([
      [resultTmp, "partial result"],
      [argsPath, "args"],
    ]);
    const calls: string[][] = [];
    await discardObservableLeg({
      reviewId: "review",
      round: 2,
      evidence: {
        reviewer: "claude",
        childName,
        attempt: 1,
        evidencePath,
        resultPath: `${evidencePath}/result.json`,
        resultId: "legacy-result",
        promptSha256: "a".repeat(64),
        transientBase,
      },
    }, {
      tmpDir: "/tmp/observable-test",
      readFile: async (path) => files.get(path),
      rm: async (path) => void files.delete(path),
      run: async (cmd) => {
        calls.push(cmd);
        return {
          code: 1,
          stdout: "",
          stderr: `run not found: ${childName}`,
          timedOut: false,
        };
      },
    });
    expect(calls).toHaveLength(1);
    expect(calls[0]).toContain("read");
    expect(calls[0]).not.toContain("stop");
    expect(files.has(resultTmp)).toBe(false);
    expect(files.has(argsPath)).toBe(false);
  });

  test("recorded cleanup preserves bootstrap evidence when exact-child stop is unproven", async () => {
    const childName = "obs-review-r2-claude";
    const evidencePath = `/evidence/${childName}`;
    const transientBase = `/tmp/observable-test/${childName}`;
    const argsPath = `${transientBase}-observable-args`;
    const donePath = `${transientBase}-observable-done`;
    const files = new Map([
      [argsPath, "args"],
      [donePath, "0"],
      [`${evidencePath}/events.jsonl`, `${JSON.stringify({
        type: "create",
        at: "2026-07-28T00:00:00Z",
        run: childName,
      })}\n`],
    ]);
    await expect(discardObservableLeg({
      reviewId: "review",
      round: 2,
      evidence: {
        reviewer: "claude",
        childName,
        attempt: 1,
        evidencePath,
        resultPath: `${evidencePath}/result.json`,
        resultId: "result-identity",
        promptSha256: "a".repeat(64),
        transientBase,
        ownedCleanupKey: "b".repeat(64),
      },
    }, {
      tmpDir: "/tmp/observable-test",
      readFile: async (path) => files.get(path),
      snapshotSize: async (path) => {
        const raw = files.get(path);
        return raw === undefined ? undefined : Buffer.byteLength(raw);
      },
      readChunk: async (path, offset, maxBytes) =>
        Buffer.from(files.get(path) ?? "").subarray(offset, offset + maxBytes),
      rm: async (path) => void files.delete(path),
      run: async () => ({
        code: 1,
        stdout: "",
        stderr: "wux: cleanup helper unavailable",
        timedOut: false,
      }),
    })).rejects.toThrow("exact-child cleanup failed");
    expect(files.get(argsPath)).toBe("args");
    expect(files.get(donePath)).toBe("0");
  });

  test("prepared cleanup does not swallow an unrelated not-found failure", async () => {
    const childName = "obs-review-r2-codex-a2";
    const tmpDir = "/tmp/observable-test";
    const base = `${tmpDir}/${childName}`;
    const preparedPath = `${base}-observable-prepared-cleanup.json`;
    const argsPath = `${base}-observable-args`;
    const files = new Map([
      [preparedPath, `${JSON.stringify({
        version: 1,
        childName,
        cleanupFiles: [],
      })}\n`],
      [argsPath, "retry args"],
    ]);
    await expect(discardPreparedObservableLeg(childName, "codex", {
      tmpDir,
      readFile: async (path) => files.get(path),
      rm: async (path) => {
        files.delete(path);
      },
      run: async () => ({
        code: 1,
        stdout: "",
        stderr: "wux: cleanup helper not found",
        timedOut: false,
      }),
    })).rejects.toThrow("exact-child cleanup failed: wux: cleanup helper not found");
    expect(files.has(preparedPath)).toBe(true);
    expect(files.has(argsPath)).toBe(true);
  });

  test("prepared cleanup verifies liveness after a run-not-found response", async () => {
    const childName = "obs-review-r2-codex-a2";
    const tmpDir = "/tmp/observable-test";
    const base = `${tmpDir}/${childName}`;
    const preparedPath = `${base}-observable-prepared-cleanup.json`;
    const files = new Map([
      [preparedPath, `${JSON.stringify({
        version: 1,
        childName,
        cleanupFiles: [],
      })}\n`],
    ]);
    let statusCalls = 0;
    await expect(discardPreparedObservableLeg(childName, "codex", {
      tmpDir,
      readFile: async (path) => files.get(path),
      rm: async (path) => {
        files.delete(path);
      },
      sleep: async () => {},
      run: async (cmd) => {
        if (cmd.includes("stop")) {
          return {
            code: 1,
            stdout: "",
            stderr: `wux: run not found: ${childName}`,
            timedOut: false,
          };
        }
        statusCalls++;
        return {
          code: 0,
          stdout: JSON.stringify([{ name: childName, status: "running" }]),
          stderr: "",
          timedOut: false,
        };
      },
    })).rejects.toThrow("exact-child cleanup did not reap the Wux session");
    expect(statusCalls).toBeGreaterThan(0);
    expect(files.has(preparedPath)).toBe(true);
  });

  test("invalid prepared cleanup metadata survives every cleanup retry", async () => {
    const childName = "obs-review-r2-codex-a2";
    const tmpDir = "/tmp/observable-test";
    const base = `${tmpDir}/${childName}`;
    const preparedPath = `${base}-observable-prepared-cleanup.json`;
    const argsPath = `${base}-observable-args`;
    const files = new Map([
      [preparedPath, "{"],
      [argsPath, "retry args"],
    ]);
    const removed: string[] = [];
    const overrides: Partial<ObservableAdapterDeps> = {
      tmpDir,
      readFile: async (path) => files.get(path),
      rm: async (path) => {
        removed.push(path);
        files.delete(path);
      },
      run: async (cmd) => cmd.includes("stop")
        ? { code: 0, stdout: "", stderr: "", timedOut: false }
        : { code: 0, stdout: "[]", stderr: "", timedOut: false },
    };
    for (let retry = 0; retry < 2; retry++) {
      await expect(discardPreparedObservableLeg(childName, "codex", overrides))
        .rejects.toThrow("invalid prepared cleanup metadata");
    }
    expect(removed).toEqual([]);
    expect(files.get(preparedPath)).toBe("{");
    expect(files.get(argsPath)).toBe("retry args");
  });

  test("prepared Claude cleanup excludes Codex-only headless paths", async () => {
    const childName = "obs-review-r2-claude";
    const tmpDir = "/tmp/observable-test";
    const base = `${tmpDir}/${childName}`;
    const preparedPath = `${base}-observable-prepared-cleanup.json`;
    const argsPath = `${base}-observable-args`;
    const promptPath = `${base}-prompt.md`;
    const outputPath = `${base}-last.txt`;
    const files = new Map([
      [preparedPath, `${JSON.stringify({
        version: 1,
        childName,
        cleanupFiles: [],
      })}\n`],
      [argsPath, "claude args"],
      [promptPath, "Codex-only neighbor"],
      [outputPath, "Codex-only neighbor"],
    ]);
    await expect(discardPreparedObservableLeg(childName, "claude", {
      tmpDir,
      readFile: async (path) => files.get(path),
      rm: async (path) => void files.delete(path),
      run: async (cmd) => cmd.includes("stop")
        ? { code: 0, stdout: "", stderr: "", timedOut: false }
        : { code: 0, stdout: "[]", stderr: "", timedOut: false },
    })).resolves.toBeUndefined();
    expect(files.has(argsPath)).toBe(false);
    expect(files.get(promptPath)).toBe("Codex-only neighbor");
    expect(files.get(outputPath)).toBe("Codex-only neighbor");
  });

  test("the production TTL reaper removes only its exact shell-hostile path", async () => {
    const dir = await mkdtemp(join(tmpdir(), "wuxr-release-reaper-"));
    const marker = join(dir, "marker with spaces;$(nope)");
    const neighbor = join(dir, "neighbor");
    try {
      await Bun.write(marker, "release\n");
      await Bun.write(neighbor, "keep\n");
      scheduleFileRemoval(marker, 25);
      for (let poll = 0; poll < 100 && await Bun.file(marker).exists(); poll++) {
        await Bun.sleep(10);
      }
      expect(await Bun.file(marker).exists()).toBe(false);
      expect(await Bun.file(neighbor).text()).toBe("keep\n");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("a transient malformed Wux liveness probe does not fail a healthy long-running leg", async () => {
    const h = harness({ complete: false });
    const originalRun = h.deps.run!;
    const originalSleep = h.deps.sleep!;
    let reads = 0;
    let sleeps = 0;
    let secondReadAfterSleeps: number | undefined;
    h.deps.run = async (cmd, opts) => {
      if (cmd.includes("read") && ++reads === 2) {
        secondReadAfterSleeps = sleeps;
        return {
          code: 0,
          stdout: "{transient",
          stderr: "",
          timedOut: false,
        };
      }
      return originalRun(cmd, opts);
    };
    h.deps.pollIntervalMs = 5_000;
    h.input.timeoutMs = 10_000;
    h.deps.sleep = async (ms) => {
      sleeps++;
      const base = `${h.deps.tmpDir}/${h.input.childName}`;
      if (reads >= 3 && !h.files.has(`${base}-observable-done`)) {
        h.files.set(`${base}-observable-stdout`, CLAUDE_STREAM);
        h.files.set(`${base}-observable-stderr`, "");
        h.files.set(`${base}-observable-done`, "0");
      }
      await originalSleep(ms);
    };
    await expect(runObservableLeg(h.input, h.deps)).resolves.toMatchObject({
      code: 0,
      timedOut: false,
    });
    expect(reads).toBeGreaterThanOrEqual(3);
    expect(secondReadAfterSleeps).toBeGreaterThanOrEqual(1);
  });

  test("creates the transient environment snapshot as mode 0600 from its first byte", async () => {
    const dir = await mkdtemp(join(tmpdir(), "wuxr-env-"));
    try {
      const path = join(dir, "env");
      const deps = defaultObservableDeps(async () => ({
        code: 0,
        stdout: "",
        stderr: "",
        timedOut: false,
      }));
      await deps.writePrivateFile(path, "SECRET=value");
      expect((await stat(path)).mode & 0o777).toBe(0o600);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("launches/discovers through released Wux interfaces and returns the validated atomic result", async () => {
    const h = harness();
    const records: unknown[] = [];
    const result = await runObservableLeg(
      {
        ...h.input,
        recordEvidence: (record) => {
          records.push(record);
        },
      },
      h.deps,
    );

    expect(result).toMatchObject({ code: 0, stdout: CLAUDE_STREAM, stderr: "", timedOut: false });
    expect(h.calls.slice(0, 4).map((call) => call.cmd.filter((part) => ["status", "run", "read"].includes(part))[0])).toEqual([
      "status",
      "run",
      "read",
      "read",
    ]);
    const launch = h.calls[1]!;
    expect(launch.cmd.slice(0, 5)).toEqual(["wux", "--local", "run", "shell", "--name"]);
    expect(launch.cmd).toContain("--json");
    expect(launch.cmd).toContain("-c");

    expect(h.files.get(`${h.runDir}/prompt.md`)).toBe("PROMPT BYTES");
    expect(h.files.get(`${h.runDir}/events.jsonl`)).toContain("review-leg-process-result");
    expect(h.files.get(`${h.runDir}/events.jsonl`)).not.toContain(
      "reviewer-machine-stream-chunk",
    );
    const rawChunks = h.files.get(`${h.runDir}/machine-stream.jsonl`)!
      .trimEnd()
      .split("\n")
      .map((line) => JSON.parse(line))
      .filter((event) => event.type === "reviewer-machine-stream-chunk");
    expect(
      Buffer.concat(rawChunks.map((event) => Buffer.from(event.data, "base64"))).toString(),
    ).toBe(CLAUDE_STREAM);
    expect(JSON.parse(h.files.get(`${h.runDir}/status.json`)!)).toMatchObject({
      version: 2,
      childName: h.input.childName,
      status: "completed",
      result: {
        state: "final",
        code: 0,
        timedOut: false,
      },
    });
    const published = JSON.parse(h.files.get(`${h.runDir}/result.json`)!);
    expect(published.identity).toMatchObject({
      id: "result-identity",
      reviewId: "review",
      round: 2,
      reviewer: "claude",
      childName: h.input.childName,
    });
    expect(published.process.stdout).toBe(CLAUDE_STREAM);
    expect(h.renames).toContainEqual([`${h.runDir}/result.json.tmp`, `${h.runDir}/result.json`]);
    expect(records).toHaveLength(3);
    expect(records.at(-1)).toMatchObject({
      ownedCleanupKey: expect.stringMatching(/^[0-9a-f]{64}$/),
      wrapperExitedNormally: true,
      eventPrefix: {
        bytes: expect.any(Number),
        sha256: expect.stringMatching(/^[0-9a-f]{64}$/),
      },
    });
  });

  test("bounds observable stderr to the same fixed tail as direct mode", async () => {
    const rawStderr = `discard-${"x".repeat(REVIEWER_STDERR_TAIL_BYTES)}-END`;
    const h = harness({ stderr: rawStderr });
    const result = await runObservableLeg(h.input, h.deps);
    expect(Buffer.byteLength(result.stderr)).toBe(REVIEWER_STDERR_TAIL_BYTES);
    expect(result.stderr.endsWith("-END")).toBe(true);
    expect(result.stderr.startsWith("discard-")).toBe(false);
    const processEvent = h.files.get(`${h.runDir}/events.jsonl`)!
      .trimEnd()
      .split("\n")
      .map((line) => JSON.parse(line))
      .find((event) => event.type === "review-leg-process-result");
    expect(processEvent.stderrBytes).toBe(Buffer.byteLength(rawStderr));
  });

  test("reaps the exact owned child and removes release-handshake transients", async () => {
    const h = harness();
    await runObservableLeg(h.input, h.deps);
    expect([...h.files.keys()].some((path) =>
      path.includes("-observable-release-")
    )).toBe(false);
    expect(h.scheduledRms).toHaveLength(1);
    expect(h.scheduledRms[0]!.path).toStartWith(
      "/tmp/observable-test/obs-review-r2-claude-observable-release-",
    );
    expect(h.scheduledRms[0]!.delayMs).toBe(60_000);
    expect(h.releaseLifecycle).toEqual([
      "schedule",
      "publish",
      "bootstrap-removed",
    ]);
    expect(h.calls.some((call) => call.cmd.join(" ") ===
      "wux --local stop obs-review-r2-claude --yes")).toBe(true);
    const stop = h.calls.find((call) => call.cmd.includes("stop"))!;
    expect(stop.opts.env?.USER).toMatch(/^wux-review-[0-9a-f]{32}$/);
    expect(stop.opts.env?.LOGNAME).toBe(stop.opts.env?.USER);
  });

  test("a release-marker write failure preserves the validated atomic result", async () => {
    const h = harness();
    const writeFile = h.deps.writeFile!;
    h.deps.writeFile = async (path, content) => {
      if (path.includes("-observable-release-")) {
        throw new Error("ENOSPC publishing release marker");
      }
      await writeFile(path, content);
    };
    await expect(runObservableLeg(h.input, h.deps)).resolves.toMatchObject({
      code: 0,
      stdout: CLAUDE_STREAM,
      timedOut: false,
    });
    expect(h.releaseLifecycle).toEqual(["schedule", "bootstrap-removed"]);
    expect(JSON.parse(h.files.get(`${h.runDir}/result.json`)!)).toMatchObject({
      process: { code: 0, stdout: CLAUDE_STREAM, timedOut: false },
    });
    expect(h.calls.filter((call) => call.cmd.includes("stop"))).toHaveLength(1);
  });

  test("backs off child-reap probes while preserving the full exit window", async () => {
    const h = harness({ releaseLingerReads: 100 });
    await expect(runObservableLeg(h.input, h.deps)).resolves.toMatchObject({
      code: 0,
      timedOut: false,
    });
    const reads = h.calls.filter((call) => call.cmd.includes("read"));
    expect(reads.length).toBeGreaterThan(2);
    expect(reads.length).toBeLessThanOrEqual(11);
    expect(h.sleeps).toEqual([1, 2, 4, 8, 16, 16, 16, 16]);
    expect(h.calls.filter((call) => call.cmd.includes("stop"))).toHaveLength(1);
  });

  test("tolerates released Wux reporting an already-dead child as not running", async () => {
    const h = harness({ stopError: "wux: tmux session is not running" });
    await expect(runObservableLeg(h.input, h.deps)).resolves.toMatchObject({
      code: 0,
      timedOut: false,
    });
  });

  test("authenticates an owned stop whose CLI response times out after publication", async () => {
    const h = harness({ stopTimesOutAfterEvent: true });
    await expect(runObservableLeg(h.input, h.deps)).resolves.toMatchObject({
      code: 0,
      timedOut: false,
    });
    expect(h.files.get(`${h.runDir}/events.jsonl`)).toContain(
      '"type":"review-leg-owned-cleanup"',
    );
  });

  test("rejects a successful owned stop without its authenticated Wux event", async () => {
    const h = harness({ omitReleaseAck: true, omitStopEvent: true });
    await expect(runObservableLeg(h.input, h.deps)).rejects.toThrow(
      "exact-child cleanup succeeded without an authenticated Wux stop event",
    );
    expect(h.lifecycleStates).not.toContain("completed");
    expect(h.lifecycleStates.at(-1)).toBe("failed");
  });

  test("rejects an already-gone stop when the wrapper never acknowledged release", async () => {
    const h = harness({
      omitReleaseAck: true,
      stopError: "wux: run is already stopped",
    });
    await expect(runObservableLeg(h.input, h.deps)).rejects.toThrow(
      "already-gone child without authenticated stop evidence",
    );
    expect(h.lifecycleStates).not.toContain("completed");
  });

  test("normal terminal cleanup preserves bootstrap when exact-child stop is unproven", async () => {
    const h = harness({
      omitReleaseAck: true,
      stopError: "wux: cleanup helper unavailable",
    });
    let failure: unknown;
    try {
      await runObservableLeg(h.input, h.deps);
    } catch (error) {
      failure = error;
    }
    expect(failure).toBeInstanceOf(ObservableLifecycleError);
    expect((failure as ObservableLifecycleError).cleanupPending).toBe(true);
    expect(h.files.has(
      `${h.deps.tmpDir}/${h.input.childName}-observable-args`,
    )).toBe(true);
  });

  test("recognizes the released Wux JSON read-after-stop envelope", async () => {
    const h = harness({ readGoneJson: true });
    await expect(runObservableLeg(h.input, h.deps)).resolves.toMatchObject({
      code: 0,
      timedOut: false,
    });
  });

  test("does not publish completed lifecycle before required transient cleanup", async () => {
    const h = harness({ failTransientCleanup: true });
    await expect(runObservableLeg(h.input, h.deps)).rejects.toThrow(
      "EPERM removing transient args",
    );
    expect(h.lifecycleStates).not.toContain("completed");
    expect(h.lifecycleStates.at(-1)).toBe("failed");
    expect(h.files.has(`${h.runDir}/result.json`)).toBe(true);
  });

  test("a stale same-name reaper cannot target a later release generation", async () => {
    const prior = harness({ resultId: "prior-result" });
    const later = harness({ resultId: "later-result" });
    await runObservableLeg(prior.input, prior.deps);
    await runObservableLeg(later.input, later.deps);
    expect(prior.scheduledRms).toHaveLength(1);
    expect(later.scheduledRms).toHaveLength(1);
    expect(prior.scheduledRms[0]!.path).not.toBe(later.scheduledRms[0]!.path);
    expect([...prior.files.keys()].some((path) =>
      path.includes("-observable-release-")
    )).toBe(false);
    expect([...later.files.keys()].some((path) =>
      path.includes("-observable-release-")
    )).toBe(false);
  });

  test("a matching stopped Wux run does not preserve an unacknowledged release signal", async () => {
    const h = harness({ wrapperStatus: "stopped" });
    await runObservableLeg(h.input, h.deps);
    expect([...h.files.keys()].some((path) =>
      path.includes("-observable-release-")
    )).toBe(false);
    expect(h.scheduledRms).toHaveLength(1);
  });

  test("ignores a stale release acknowledgement from another result identity and still reaps", async () => {
    const h = harness();
    await runObservableLeg(h.input, {
      ...h.deps,
      readFile: async (path) =>
        path.includes("-observable-released-")
          ? "stale-result-identity"
          : h.files.get(path),
    });
    expect(h.scheduledRms).toHaveLength(1);
    expect([...h.files.keys()].some((path) =>
      path.includes("-observable-release-")
    )).toBe(false);
    expect(h.calls.some((call) => call.cmd.includes("stop"))).toBe(true);
  });

  test("malformed and unknown events stay raw, diagnose safely, and do not disrupt atomic collection", async () => {
    const stdout = [
      "{malformed",
      JSON.stringify({ type: "future.event", secret: "TOKEN_DO_NOT_RENDER" }),
      CLAUDE_STREAM,
    ].join("\n");
    const h = harness({ stdout });
    const result = await runObservableLeg(h.input, h.deps);
    expect(result.stdout).toBe(CLAUDE_STREAM);
    const status = JSON.parse(h.files.get(`${h.runDir}/status.json`)!);
    expect(status.diagnostics).toMatchObject({ malformed: 1, unknown: 1 });
    // Raw evidence intentionally retains this payload as base64; this assertion
    // proves only that safe diagnostics never echo it as plaintext.
    expect(h.files.get(`${h.runDir}/events.jsonl`)).not.toContain("TOKEN_DO_NOT_RENDER");
    const pane = h.appends
      .filter(({ path }) => path.endsWith("-observable-pane"))
      .map(({ content }) => content)
      .join("\n");
    expect(pane).not.toContain("TOKEN_DO_NOT_RENDER");
  });

  test("a renderer failure is observational and cannot change the atomic result", async () => {
    const h = harness();
    const result = await runObservableLeg(h.input, {
      ...h.deps,
      renderPane: () => {
        throw new Error("renderer exploded with TOKEN_SECRET");
      },
    });
    expect(result.stdout).toBe(CLAUDE_STREAM);
    expect(JSON.parse(h.files.get(`${h.runDir}/result.json`)!)).toMatchObject({
      process: { code: 0 },
    });
    expect(JSON.parse(h.files.get(`${h.runDir}/status.json`)!)).toMatchObject({
      status: "completed",
      diagnostics: { renderer: expect.any(Number) },
      result: { state: "final", code: 0 },
    });
    expect(
      JSON.parse(h.files.get(`${h.runDir}/status.json`)!).diagnostics.renderer,
    ).toBeGreaterThan(0);
    expect(h.files.get(`${h.runDir}/events.jsonl`)).toContain(
      '"category":"renderer-failure"',
    );
    expect(h.files.get(`${h.runDir}/events.jsonl`)).not.toContain("TOKEN_SECRET");
  });

  test("a status write failure is counted in the surviving pane and final status", async () => {
    const h = harness();
    const rename = h.deps.rename!;
    let failed = false;
    const result = await runObservableLeg(h.input, {
      ...h.deps,
      rename: async (from, to) => {
        if (!failed && to.endsWith("/status.json")) {
          failed = true;
          throw new Error("status write failed");
        }
        await rename(from, to);
      },
    });
    expect(result.stdout).toBe(CLAUDE_STREAM);
    expect(
      JSON.parse(h.files.get(`${h.runDir}/status.json`)!).diagnostics.renderer,
    ).toBeGreaterThan(0);
    expect(
      h.appends
        .filter(({ path }) => path.endsWith("-observable-pane"))
        .map(({ content }) => content)
        .join("\n"),
    ).toContain("diagnostics 1");
  });

  test("a pane write failure is counted when status is the surviving sink", async () => {
    const h = harness();
    const appendFile = h.deps.appendFile!;
    let failed = false;
    const result = await runObservableLeg(h.input, {
      ...h.deps,
      appendFile: async (path, content) => {
        if (!failed && path.endsWith("-observable-pane")) {
          failed = true;
          throw new Error("pane write failed");
        }
        await appendFile(path, content);
      },
    });
    expect(result.stdout).toBe(CLAUDE_STREAM);
    expect(
      JSON.parse(h.files.get(`${h.runDir}/status.json`)!).diagnostics.renderer,
    ).toBeGreaterThan(0);
  });

  test("keeps argv injection-safe and stdin byte-equivalent in the bootstrap files", async () => {
    const h = harness();
    const argsPath = `/tmp/observable-test/${h.input.childName}-observable-args`;
    const stdinPath = `/tmp/observable-test/${h.input.childName}-observable-stdin`;
    const envPath = `/tmp/observable-test/${h.input.childName}-observable-env`;
    let seenArgs: string | undefined;
    let seenStdin: string | undefined;
    let seenEnv: string | undefined;
    let seenScript: string | undefined;
    const writeFile = h.deps.writeFile!;
    const writePrivateFile = h.deps.writePrivateFile!;
    h.deps.writeFile = async (path, content) => {
      if (path === argsPath) seenArgs = content;
      if (path === stdinPath) seenStdin = content;
      if (path.endsWith("-observable.sh")) seenScript = content;
      await writeFile(path, content);
    };
    h.deps.writePrivateFile = async (path, content) => {
      if (path === envPath) seenEnv = content;
      await writePrivateFile(path, content);
    };
    const input = {
      ...h.input,
      argv: [...h.input.argv, ""],
      env: { CODEX_HOME: "/isolated/codex", PATH: "/fake/bin:/usr/bin" },
    };
    await runObservableLeg(input, h.deps);
    expect(seenArgs?.endsWith("\0")).toBe(true);
    expect(seenArgs?.split("\0").slice(0, -1)).toEqual(input.argv);
    expect(seenStdin).toBe(h.input.stdin);
    expect(seenEnv?.split("\0")).toContain("CODEX_HOME=/isolated/codex");
    expect(seenEnv?.split("\0")).toContain("PATH=/fake/bin:/usr/bin");
    expect(h.privateWrites).toContain(envPath);
    // The untrusted model value is absent from the shell command itself.
    expect(h.calls.find((call) => call.cmd.includes("run"))!.cmd.join(" ")).not.toContain("model with spaces");
    expect(seenScript).toContain('/usr/bin/env -i "${__e[@]}" "${__a[@]}"');
  });

  test("collects a Codex -o file into result.json and returns that structured output", async () => {
    const h = harness({ structuredOutput: REPORT });
    const result = await runObservableLeg(
      { ...h.input, reviewer: "codex", outputPath: h.outputPath },
      h.deps,
    );
    expect(result.structuredOutput).toBe(REPORT);
    expect(JSON.parse(h.files.get(`${h.runDir}/result.json`)!).output).toBe(REPORT);
  });

  test("a name collision fails clearly before launch and never attaches", async () => {
    const h = harness({ existing: ["obs-review-r2-claude"] });
    await expect(runObservableLeg(h.input, h.deps)).rejects.toThrow(
      "obs-review-r2-claude observable reviewer leg: name collision",
    );
    expect(h.calls).toHaveLength(1);
    expect(h.calls[0]!.cmd).toContain("status");
  });

  test("invalid Wux JSON and an unsafe runDir fail closed with the leg named", async () => {
    const badStatus = harness({ statusJson: "{bad" });
    await expect(runObservableLeg(badStatus.input, badStatus.deps)).rejects.toThrow(
      "obs-review-r2-claude observable reviewer leg: invalid wux status",
    );

    const wrongLaunch = harness({ launchJson: JSON.stringify({ name: "other", backend: "shell" }) });
    await expect(runObservableLeg(wrongLaunch.input, wrongLaunch.deps)).rejects.toThrow(
      "obs-review-r2-claude observable reviewer leg: invalid wux run",
    );

    const unsafe = harness({ readJson: JSON.stringify({ name: "obs-review-r2-claude", runDir: "/tmp/unrelated" }) });
    await expect(runObservableLeg(unsafe.input, unsafe.deps)).rejects.toThrow(
      "obs-review-r2-claude observable reviewer leg: unsafe runDir",
    );
  });

  test("a non-Error journal rejection publishes the original terminal diagnostic", async () => {
    const h = harness();
    await expect(runObservableLeg({
      ...h.input,
      recordEvidence: () => Promise.reject("journal checkpoint rejected"),
    }, h.deps)).rejects.toThrow("journal checkpoint rejected");
    expect(JSON.parse(h.files.get(`${h.runDir}/lifecycle.json`)!)).toMatchObject({
      state: "failed",
      diagnostic: "journal checkpoint rejected",
    });
  });

  test("missing or invalid atomic result.json fails closed with the leg named", async () => {
    const missing = harness({ hideResult: true });
    await expect(runObservableLeg(missing.input, missing.deps)).rejects.toThrow(
      "obs-review-r2-claude observable reviewer leg: missing atomic result.json",
    );

    const corrupt = harness({ corruptResult: true });
    await expect(runObservableLeg(corrupt.input, corrupt.deps)).rejects.toThrow(
      "obs-review-r2-claude observable reviewer leg: invalid atomic result.json",
    );

    const replay = harness({ preexistingResult: true });
    await expect(runObservableLeg(replay.input, replay.deps)).rejects.toThrow(
      "duplicate or replayed atomic result",
    );
    expect(replay.files.get(`${replay.runDir}/result.json`)).toContain(
      '"replayed":true',
    );
  });

  test("timeout publishes atomic fail-closed status and never publishes result.json", async () => {
    const h = harness({ complete: false });
    const result = await runObservableLeg({ ...h.input, timeoutMs: 2 }, h.deps);
    expect(result).toEqual({ code: null, stdout: "", stderr: "", timedOut: true });
    expect(JSON.parse(h.files.get(`${h.runDir}/status.json`)!)).toMatchObject({
      status: "timed-out",
      result: {
        state: "pending",
        timedOut: true,
      },
    });
    expect(h.files.has(`${h.runDir}/result.json`)).toBe(false);
  });

  test("parent-side timeout bounds its final drain against a runaway writer", async () => {
    const h = harness({ complete: false });
    let reads = 0;
    const snapshot = new Uint8Array(OBSERVABLE_DRAIN_READS_PER_PASS * 2).fill(0x78);
    const result = await runObservableLeg(
      { ...h.input, timeoutMs: 0 },
      {
        ...h.deps,
        pollIntervalMs: 1000,
        snapshotSize: async (path) => path.endsWith("/events.jsonl")
          ? h.deps.snapshotSize!(path)
          : snapshot.byteLength,
        readChunk: async (path, offset, maxBytes) => {
          if (path.endsWith("/events.jsonl")) {
            return h.deps.readChunk!(path, offset, maxBytes);
          }
          reads += 1;
          return Uint8Array.of(0x78);
        },
      },
    );
    expect(result.timedOut).toBe(true);
    expect(reads).toBe(OBSERVABLE_DRAIN_READS_PER_PASS * 2);
  });

  test("completed process snapshots once instead of following a stdout-inheriting writer", async () => {
    const h = harness();
    let reads = 0;
    const snapshot = new Uint8Array(OBSERVABLE_DRAIN_READS_PER_PASS).fill(0x78);
    const result = await runObservableLeg(h.input, {
      ...h.deps,
      snapshotSize: async (path) =>
        path.endsWith("/events.jsonl")
          ? h.deps.snapshotSize!(path)
          : path.endsWith("-observable-stderr") ? 0 : snapshot.byteLength,
      readChunk: async (path, offset, maxBytes) => {
        if (path.endsWith("/events.jsonl")) {
          return h.deps.readChunk!(path, offset, maxBytes);
        }
        reads += 1;
        return Uint8Array.of(0x78);
      },
    });
    expect(result.timedOut).toBe(false);
    expect(reads).toBe(OBSERVABLE_DRAIN_READS_PER_PASS);
    expect(result.stdout).toBe("");
  });

  test("post-exit snapshot captures every byte beyond the bounded live pass", async () => {
    const h = harness();
    const snapshot = new Uint8Array(
      MACHINE_EVENT_READ_CHUNK_BYTES * (OBSERVABLE_DRAIN_READS_PER_PASS + 1) + 17,
    ).fill(0x78);
    const result = await runObservableLeg(h.input, {
      ...h.deps,
      snapshotSize: async (path) =>
        path.endsWith("/events.jsonl")
          ? h.deps.snapshotSize!(path)
          : path.endsWith("-observable-stderr") ? 0 : snapshot.byteLength,
      readChunk: async (path, offset, maxBytes) =>
        path.endsWith("/events.jsonl")
          ? h.deps.readChunk!(path, offset, maxBytes)
          : snapshot.subarray(offset, offset + maxBytes),
    });
    expect(result.stdout).toBe("");
    const chunks = h.files.get(`${h.runDir}/machine-stream.jsonl`)!
      .trimEnd()
      .split("\n")
      .map((line) => JSON.parse(line))
      .filter((event) => event.type === "reviewer-machine-stream-chunk");
    expect(
      Buffer.concat(chunks.map((event) => Buffer.from(event.data, "base64"))),
    ).toEqual(Buffer.from(snapshot));
  });

  test("fails closed when the completed stream shrinks below the live offset", async () => {
    const h = harness();
    let read = 0;
    await expect(runObservableLeg(h.input, {
      ...h.deps,
      snapshotSize: async (path) => path.endsWith("/events.jsonl")
        ? h.deps.snapshotSize!(path)
        : 1,
      readChunk: async (path, offset, maxBytes) => {
        if (path.endsWith("/events.jsonl")) {
          return h.deps.readChunk!(path, offset, maxBytes);
        }
        read += 1;
        return read === 1 ? Uint8Array.of(0x78, 0x79) : new Uint8Array();
      },
    })).rejects.toThrow("observable machine stream shrank during capture");
  });

  test("fails closed on a zero-byte read below the completed snapshot boundary", async () => {
    const h = harness();
    await expect(runObservableLeg(h.input, {
      ...h.deps,
      snapshotSize: async (path) => path.endsWith("/events.jsonl")
        ? h.deps.snapshotSize!(path)
        : 1,
      readChunk: async (path, offset, maxBytes) => path.endsWith("/events.jsonl")
        ? h.deps.readChunk!(path, offset, maxBytes)
        : new Uint8Array(),
    })).rejects.toThrow("observable machine stream shrank during capture");
  });
});
