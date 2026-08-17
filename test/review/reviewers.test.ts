import { describe, expect, test } from "bun:test";
import { DEFAULT_LENSES } from "../../src/review/lenses";
import { ObservableLifecycleError } from "../../src/backends/observable";
import {
  observableSessionName,
  runReviewers,
  sessionName,
  type Backend,
} from "../../src/review/reviewers";

const report = (findings: unknown[]) => "```json\n" + JSON.stringify({ findings }) + "\n```";
const APPROVE = report([]);
const BLOCK = report([{ lens: "correctness", file: "x.ts", line: 1, severity: "must-fix", finding: "bug" }]);

const DIFF = "diff --git a/x.ts b/x.ts\n+changed\n";

describe("runReviewers", () => {
  test("feeds both reviewers the SAME prompt (diff + full lens set)", async () => {
    const seen: Record<string, string> = {};
    const make = (name: string): Backend => async (prompt) => {
      seen[name] = prompt;
      return APPROVE;
    };
    await runReviewers(DIFF, DEFAULT_LENSES, { backends: { claude: make("claude"), codex: make("codex") } });
    expect(seen.claude).toBe(seen.codex);
    expect(seen.claude).toContain(DIFF);
    for (const lens of DEFAULT_LENSES) {
      expect(seen.claude).toContain(lens.name);
    }
  });

  test("runs both reviewers concurrently", async () => {
    let active = 0;
    let maxActive = 0;
    const slow: Backend = async () => {
      active++;
      maxActive = Math.max(maxActive, active);
      await new Promise((r) => setTimeout(r, 30));
      active--;
      return APPROVE;
    };
    await runReviewers(DIFF, DEFAULT_LENSES, { backends: { claude: slow, codex: slow } });
    expect(maxActive).toBe(2);
  });

  test("returns parsed results + computed verdicts for both reviewers", async () => {
    const result = await runReviewers(DIFF, DEFAULT_LENSES, {
      backends: { claude: async () => APPROVE, codex: async () => BLOCK },
      sessionId: "abc",
    });
    expect(result.sessionId).toBe("abc");
    expect(result.claude.verdict).toBe("approve");
    expect(result.codex.verdict).toBe("block");
    expect(result.codex.findings).toHaveLength(1);
  });

  test("passes per-reviewer session names and model overrides through", async () => {
    const opts: Record<string, unknown> = {};
    const capture = (name: string): Backend => async (_p, o) => {
      opts[name] = o;
      return APPROVE;
    };
    await runReviewers(DIFF, DEFAULT_LENSES, {
      backends: { claude: capture("claude"), codex: capture("codex") },
      sessionId: "s1",
      models: { claude: "claude-opus-4-8", codex: "gpt-5.4" },
      direct: true,
    });
    expect(opts.claude).toMatchObject({ sessionName: sessionName("s1", "claude"), model: "claude-opus-4-8", direct: true });
    expect(opts.codex).toMatchObject({ sessionName: sessionName("s1", "codex"), model: "gpt-5.4", direct: true });
  });

  test("rejects an unsafe session id override (path traversal / metacharacters)", async () => {
    const backends = { claude: async () => APPROVE, codex: async () => APPROVE };
    for (const bad of ["../etc", "a/b", "a b", "..", "$(x)", ""]) {
      await expect(runReviewers(DIFF, DEFAULT_LENSES, { backends, sessionId: bad })).rejects.toThrow(
        "invalid session id",
      );
    }
    // a safe id is accepted
    const ok = await runReviewers(DIFF, DEFAULT_LENSES, { backends, sessionId: "abc-123_X" });
    expect(ok.sessionId).toBe("abc-123_X");
  });

  test("threads persist (session mode) to both backends", async () => {
    const opts: Record<string, unknown> = {};
    const capture = (name: string): Backend => async (_p, o) => {
      opts[name] = o;
      return APPROVE;
    };
    await runReviewers(DIFF, DEFAULT_LENSES, {
      backends: { claude: capture("claude"), codex: capture("codex") },
      sessionId: "s1",
      persist: true,
    });
    expect(opts.claude).toMatchObject({ persist: true });
    expect(opts.codex).toMatchObject({ persist: true });
  });

  test("candidate observable mode names fresh per-round children with a configurable safe prefix", async () => {
    const opts: Record<string, unknown> = {};
    const capture = (name: string): Backend => async (_p, o) => {
      opts[name] = o;
      return APPROVE;
    };
    await runReviewers(DIFF, DEFAULT_LENSES, {
      backends: { claude: capture("claude"), codex: capture("codex") },
      sessionId: "review111",
      round: 3,
      direct: false,
      observablePrefix: "candidate",
      observableExecutionId: "exec3",
    });
    expect(opts.claude).toMatchObject({
      sessionName: observableSessionName("candidate", "review111", 3, "claude", "exec3"),
      reviewId: "review111",
      round: 3,
      reviewer: "claude",
    });
    expect(opts.codex).toMatchObject({
      sessionName: "candidate-review111-r3-xexec3-codex",
      reviewer: "codex",
    });
  });

  test("candidate observable mode returns per-leg durable evidence records, including retries", async () => {
    const evidenceBackend = (reviewer: "claude" | "codex"): Backend => async (_prompt, opts) => {
      const attemptCount = reviewer === "codex" ? 2 : 1;
      for (let attempt = 1; attempt <= attemptCount; attempt++) {
        const childName = attempt === 1 ? opts.sessionName : `${opts.sessionName}-a${attempt}`;
        opts.recordEvidence?.({
          reviewer,
          childName,
          attempt,
          evidencePath: `/evidence/${childName}`,
          resultPath: `/evidence/${childName}/result.json`,
          resultId: `${reviewer}-${attempt}`,
          promptSha256: "a".repeat(64),
        });
      }
      return APPROVE;
    };
    const result = await runReviewers(DIFF, DEFAULT_LENSES, {
      backends: { claude: evidenceBackend("claude"), codex: evidenceBackend("codex") },
      sessionId: "review111",
      round: 2,
      direct: false,
      observableExecutionId: "exec2",
    });
    expect(result.evidence?.claude).toHaveLength(1);
    expect(result.evidence?.codex).toHaveLength(2);
    expect(result.evidence?.codex[1]?.childName).toBe("wuxr-review111-r2-xexec2-codex-a2");
  });

  test("a repeated failed round gets fresh execution-scoped child names", async () => {
    const names: string[] = [];
    const backend: Backend = async (_prompt, opts) => {
      names.push(opts.sessionName);
      return APPROVE;
    };
    for (const observableExecutionId of ["first", "second"]) {
      await runReviewers(DIFF, DEFAULT_LENSES, {
        backends: { claude: backend, codex: backend },
        sessionId: "retryable",
        round: 1,
        direct: false,
        observableExecutionId,
      });
    }
    expect(new Set(names).size).toBe(4);
    expect(names).toContain("wuxr-retryable-r1-xfirst-claude");
    expect(names).toContain("wuxr-retryable-r1-xsecond-claude");
  });

  test("an unsafe observable prefix fails before either backend starts; direct mode ignores it", async () => {
    let calls = 0;
    const backend: Backend = async () => {
      calls++;
      return APPROVE;
    };
    await expect(
      runReviewers(DIFF, DEFAULT_LENSES, {
        backends: { claude: backend, codex: backend },
        direct: false,
        observablePrefix: "../bad",
      }),
    ).rejects.toThrow("invalid observable prefix");
    expect(calls).toBe(0);

    await expect(
      runReviewers(DIFF, DEFAULT_LENSES, {
        backends: { claude: backend, codex: backend },
        direct: false,
        observableExecutionId: "../bad",
      }),
    ).rejects.toThrow("invalid observable execution id");
    expect(calls).toBe(0);

    await expect(
      runReviewers(DIFF, DEFAULT_LENSES, {
        backends: { claude: backend, codex: backend },
        observablePrefix: "../ignored",
        direct: true,
      }),
    ).resolves.toBeDefined();
  });

  test("a backend that fails is a hard error (both reviewers are required)", async () => {
    const boom: Backend = async () => {
      throw new Error("launch failed");
    };
    await expect(
      runReviewers(DIFF, DEFAULT_LENSES, { backends: { claude: async () => APPROVE, codex: boom } }),
    ).rejects.toThrow("codex reviewer failed to run");
  });

  test("an observable leg failure cancels and awaits its sibling before recording terminal state", async () => {
    let siblingCleaned = false;
    const states: string[] = [];
    const sibling: Backend = async (_prompt, opts) => {
      await new Promise<void>((_resolve, reject) => {
        const cancel = () => {
          siblingCleaned = true;
          reject(new Error("sibling cleanup complete"));
        };
        if (opts.signal?.aborted) {
          cancel();
        } else {
          opts.signal?.addEventListener("abort", cancel, { once: true });
        }
      });
      return APPROVE;
    };
    await expect(runReviewers(DIFF, DEFAULT_LENSES, {
      backends: {
        claude: async () => {
          throw new Error("primary failed");
        },
        codex: sibling,
      },
      direct: false,
      observableExecutionId: "cleanup",
      finishObservableRound: async (state) => void states.push(state),
    })).rejects.toThrow("claude reviewer failed to run: primary failed");
    expect(siblingCleaned).toBe(true);
    expect(states).toEqual(["failed"]);
  });

  test("a terminal journal failure never masks the primary observable leg error", async () => {
    await expect(runReviewers(DIFF, DEFAULT_LENSES, {
      backends: {
        claude: async () => {
          throw new Error("primary failed");
        },
        codex: async () => APPROVE,
      },
      direct: false,
      observableExecutionId: "journalfail",
      finishObservableRound: async () => {
        throw new Error("round journal ENOSPC");
      },
    })).rejects.toThrow("claude reviewer failed to run: primary failed");
  });

  test("any leg cleanup failure marks the observable round cleanup-pending", async () => {
    const terminal: Array<{ state: string; cleanupPending?: boolean }> = [];
    await expect(runReviewers(DIFF, DEFAULT_LENSES, {
      backends: {
        claude: async () => APPROVE,
        codex: async () => {
          throw new ObservableLifecycleError(
            "codex terminal cleanup failed",
            "failed",
            "/evidence/codex",
            true,
          );
        },
      },
      direct: false,
      observableExecutionId: "cleanuppending",
      finishObservableRound: async (state, _diagnostic, cleanupPending) => {
        terminal.push({ state, cleanupPending });
      },
    })).rejects.toThrow("codex terminal cleanup failed");
    expect(terminal).toEqual([{ state: "failed", cleanupPending: true }]);
  });

  test("a parent interrupt racing terminal cleanup preserves a valid failure journal", async () => {
    const parent = new AbortController();
    const terminal: Array<{ state: string; cleanupPending?: boolean }> = [];
    await expect(runReviewers(DIFF, DEFAULT_LENSES, {
      backends: {
        claude: async () => {
          parent.abort("parent-interrupted");
          throw new ObservableLifecycleError(
            "claude terminal cleanup failed",
            "failed",
            "/evidence/claude",
            true,
          );
        },
        codex: async () => APPROVE,
      },
      direct: false,
      observableExecutionId: "cleanupinterrupt",
      signal: parent.signal,
      finishObservableRound: async (state, _diagnostic, cleanupPending) => {
        terminal.push({ state, cleanupPending });
      },
    })).rejects.toThrow("claude terminal cleanup failed");
    expect(terminal).toEqual([{ state: "failed", cleanupPending: true }]);
  });

  test("a sibling cleanup obligation is included in the surfaced primary failure", async () => {
    const sibling: Backend = async (_prompt, opts) => {
      await new Promise<void>((resolve) => {
        if (opts.signal?.aborted) {
          resolve();
        } else {
          opts.signal?.addEventListener("abort", () => resolve(), { once: true });
        }
      });
      throw new ObservableLifecycleError(
        "codex terminal cleanup failed",
        "failed",
        "/evidence/codex",
        true,
      );
    };
    await expect(runReviewers(DIFF, DEFAULT_LENSES, {
      backends: {
        claude: async () => {
          throw new Error("primary failed");
        },
        codex: sibling,
      },
      direct: false,
      sessionId: "cleanupnotice",
      observableExecutionId: "cleanupnotice",
    })).rejects.toThrow(
      "primary failed; sibling terminal cleanup failed: codex terminal cleanup failed; run `wux-review reconcile cleanupnotice`",
    );
  });

  test("a terminal journal failure never masks parent interruption after collection", async () => {
    const abort = new AbortController();
    const backend: Backend = async () => {
      abort.abort("parent-interrupted");
      return APPROVE;
    };
    await expect(runReviewers(DIFF, DEFAULT_LENSES, {
      backends: { claude: backend, codex: backend },
      direct: false,
      signal: abort.signal,
      observableExecutionId: "intjournalfail",
      finishObservableRound: async () => {
        throw new Error("round journal ENOSPC");
      },
    })).rejects.toThrow("interrupted after child collection");
  });

  test("a pre-aborted observable round starts neither backend nor recovery preparation", async () => {
    const abort = new AbortController();
    abort.abort("parent-interrupted");
    let backendCalls = 0;
    let prepareCalls = 0;
    const backend: Backend = async () => {
      backendCalls++;
      return APPROVE;
    };
    await expect(runReviewers(DIFF, DEFAULT_LENSES, {
      backends: { claude: backend, codex: backend },
      direct: false,
      signal: abort.signal,
      prepareObservableRound: async () => {
        prepareCalls++;
      },
    })).rejects.toThrow("interrupted before child launch");
    expect(backendCalls).toBe(0);
    expect(prepareCalls).toBe(0);
  });

  test("a backend returning unparseable output is a hard error", async () => {
    await expect(
      runReviewers(DIFF, DEFAULT_LENSES, { backends: { claude: async () => "looks good", codex: async () => APPROVE } }),
    ).rejects.toThrow("claude reviewer returned no JSON");
  });
});
