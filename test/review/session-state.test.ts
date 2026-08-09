import { describe, expect, test } from "bun:test";
import { createSessionStore, type SessionStoreDeps } from "../../src/review/session-state";
import type { SessionState } from "../../src/review/types";

// An in-memory FS boundary so the store is exercised without touching disk.
function memDeps(): SessionStoreDeps & { files: Map<string, string> } {
  const files = new Map<string, string>();
  const rename = async (from: string, to: string) => {
    const content = files.get(from);
    if (content === undefined) throw new Error(`missing ${from}`);
    files.set(to, content);
    files.delete(from);
  };
  return {
    files,
    stateDir: "/state",
    readFile: async (path) => files.get(path),
    writeFile: async (path, content) => void files.set(path, content),
    rename,
    mkdir: async () => undefined,
    rm: async (path) => void files.delete(path),
  };
}

const state: SessionState = {
  version: 1,
  round: 2,
  results: {
    claude: { reviewer: "claude", verdict: "block", findings: [{ lens: "correctness", file: "x.ts", line: 10, severity: "must-fix", finding: "bug" }] },
    codex: { reviewer: "codex", verdict: "approve", findings: [] },
  },
  sticky: { claude: [], codex: ['["k.ts",2,"clarity","nit note"]'] },
  ledger: {
    claude: [],
    codex: [{ key: '["x.ts",42,"security","regex $ matches"]', finding: "regex $ matches before newline", evidence: "node -e ... prints false", round: 1, refutedRepros: [] }],
  },
};

describe("session store", () => {
  test("save then load round-trips the state", async () => {
    const deps = memDeps();
    const store = createSessionStore(deps);
    await store.save("sess-1", state);
    expect(deps.files.has("/state/sess-1.json")).toBe(true);
    expect(await store.load("sess-1")).toEqual(state);
    expect([...deps.files.keys()].some((path) => path.endsWith(".tmp"))).toBe(false);
  });

  test("load promotes a valid crash-interrupted atomic session write", async () => {
    const deps = memDeps();
    const newer = { ...state, round: 3 };
    deps.files.set("/state/sess-1.json", JSON.stringify(state));
    deps.files.set("/state/sess-1.json.tmp", JSON.stringify(newer));
    await expect(createSessionStore(deps).load("sess-1")).resolves.toEqual(newer);
    expect(JSON.parse(deps.files.get("/state/sess-1.json")!)).toEqual(newer);
    expect(deps.files.has("/state/sess-1.json.tmp")).toBe(false);
  });

  test("load discards a malformed atomic temp and retains valid committed state", async () => {
    const deps = memDeps();
    deps.files.set("/state/sess-1.json", JSON.stringify(state));
    deps.files.set("/state/sess-1.json.tmp", "{");
    await expect(createSessionStore(deps).load("sess-1")).resolves.toEqual(state);
    expect(deps.files.has("/state/sess-1.json.tmp")).toBe(false);
  });

  test("load of a missing session → undefined", async () => {
    const store = createSessionStore(memDeps());
    expect(await store.load("nope")).toBeUndefined();
  });

  test("an older state file with no `sticky` field loads with empty sticky sets (backward-compatible)", async () => {
    const deps = memDeps();
    const legacy = {
      version: 1,
      results: {
        claude: { reviewer: "claude", verdict: "approve", findings: [] },
        codex: { reviewer: "codex", verdict: "approve", findings: [] },
      },
    };
    deps.files.set("/state/legacy.json", JSON.stringify(legacy));
    const loaded = await createSessionStore(deps).load("legacy");
    expect(loaded?.sticky).toEqual({ claude: [], codex: [] });
  });

  test("a pre-#100 state file with no `round` loads with round 0 (so the next re-review is round 1)", async () => {
    const deps = memDeps();
    const legacy = {
      version: 1,
      results: {
        claude: { reviewer: "claude", verdict: "approve", findings: [] },
        codex: { reviewer: "codex", verdict: "approve", findings: [] },
      },
      sticky: { claude: [], codex: [] },
    };
    deps.files.set("/state/legacy.json", JSON.stringify(legacy));
    const loaded = await createSessionStore(deps).load("legacy");
    expect(loaded?.round).toBe(0);
  });

  test("the round counter round-trips through save/load", async () => {
    const deps = memDeps();
    const store = createSessionStore(deps);
    await store.save("s", { ...state, round: 5 });
    expect((await store.load("s"))?.round).toBe(5);
  });

  test("the refutation ledger round-trips, and a finding's repro is persisted (#101)", async () => {
    const deps = memDeps();
    const store = createSessionStore(deps);
    const withRepro: SessionState = {
      ...state,
      results: {
        claude: { reviewer: "claude", verdict: "block", findings: [{ lens: "security", file: "a.ts", line: 1, severity: "must-fix", finding: "npe", repro: "node -e 'x'" }] },
        codex: { reviewer: "codex", verdict: "approve", findings: [] },
      },
    };
    await store.save("s", withRepro);
    const loaded = await store.load("s");
    expect(loaded?.ledger?.codex[0]?.evidence).toBe("node -e ... prints false");
    expect(loaded?.results.claude.findings[0]?.repro).toBe("node -e 'x'");
  });

  test("a pre-#101 state file with no `ledger` loads with empty ledgers (backward-compatible)", async () => {
    const deps = memDeps();
    deps.files.set(
      "/state/legacy.json",
      JSON.stringify({
        version: 1,
        round: 1,
        results: { claude: { reviewer: "claude", verdict: "approve", findings: [] }, codex: { reviewer: "codex", verdict: "approve", findings: [] } },
        sticky: { claude: [], codex: [] },
      }),
    );
    const loaded = await createSessionStore(deps).load("legacy");
    expect(loaded?.ledger).toEqual({ claude: [], codex: [] });
  });

  test("observable child/evidence identity round-trips additively", async () => {
    const deps = memDeps();
    const store = createSessionStore(deps);
    const withChildren: SessionState = {
      ...state,
      children: [
        {
          round: 2,
          claude: [{
            reviewer: "claude",
            childName: "obs-s-r2-claude",
            attempt: 1,
            evidencePath: "/evidence/obs-s-r2-claude",
            resultPath: "/evidence/obs-s-r2-claude/result.json",
            resultId: "result-c",
            promptSha256: "a".repeat(64),
          }],
          codex: [{
            reviewer: "codex",
            childName: "obs-s-r2-codex",
            attempt: 1,
            evidencePath: "/evidence/obs-s-r2-codex",
            resultPath: "/evidence/obs-s-r2-codex/result.json",
            resultId: "result-x",
            promptSha256: "b".repeat(64),
          }],
        },
      ],
    };
    await store.save("s", withChildren);
    expect((await store.load("s"))?.children).toEqual(withChildren.children);
  });

  test("released state without `children` remains readable without changing its shape", async () => {
    const deps = memDeps();
    deps.files.set("/state/legacy.json", JSON.stringify(state));
    const loaded = await createSessionStore(deps).load("legacy");
    expect(loaded?.children).toBeUndefined();
  });

  test("cross-leg observable evidence is treated as corrupt state", async () => {
    const deps = memDeps();
    deps.files.set(
      "/state/s.json",
      JSON.stringify({
        ...state,
        children: [{
          round: 1,
          claude: [{
            reviewer: "codex",
            childName: "wrong",
            attempt: 1,
            evidencePath: "/evidence/wrong",
            resultPath: "/evidence/wrong/result.json",
            resultId: "wrong",
            promptSha256: "a".repeat(64),
          }],
          codex: [],
        }],
      }),
    );
    expect(await createSessionStore(deps).load("s")).toBeUndefined();
  });

  test("clear removes the state (a subsequent load → undefined)", async () => {
    const deps = memDeps();
    const store = createSessionStore(deps);
    await store.save("sess-1", state);
    await store.clear("sess-1");
    expect(deps.files.has("/state/sess-1.json")).toBe(false);
    expect(await store.load("sess-1")).toBeUndefined();
  });

  test("clear of a missing session is a no-op (no throw)", async () => {
    const store = createSessionStore(memDeps());
    await expect(store.clear("nope")).resolves.toBeUndefined();
  });

  test("corrupt JSON → undefined (degrade to a context-free review, never crash)", async () => {
    const deps = memDeps();
    deps.files.set("/state/sess-1.json", "{not json");
    const store = createSessionStore(deps);
    expect(await store.load("sess-1")).toBeUndefined();
    expect(await store.loadForCompare!("sess-1")).toEqual({
      state: undefined,
      reliable: false,
      corrupt: true,
    });
    expect(await store.loadForCompare!("missing")).toEqual({
      state: undefined,
      reliable: true,
    });
  });

  test("wrong-shape / stale-schema JSON → undefined", async () => {
    const deps = memDeps();
    deps.files.set("/state/sess-1.json", JSON.stringify({ version: 2, results: {} }));
    expect(await createSessionStore(deps).load("sess-1")).toBeUndefined();
    deps.files.set("/state/sess-2.json", JSON.stringify({ version: 1, results: { claude: { verdict: "maybe" } } }));
    expect(await createSessionStore(deps).load("sess-2")).toBeUndefined();
  });

  test("semantically-corrupt state is ignored: a leg key that disagrees with its reviewer field", async () => {
    const deps = memDeps();
    // results.claude carries reviewer:"codex" — a swap that would leak codex's
    // findings into claude's next-round prompt. Must be rejected (→ undefined).
    const swapped = {
      version: 1,
      results: {
        claude: { reviewer: "codex", verdict: "approve", findings: [] },
        codex: { reviewer: "codex", verdict: "approve", findings: [] },
      },
    };
    deps.files.set("/state/s.json", JSON.stringify(swapped));
    expect(await createSessionStore(deps).load("s")).toBeUndefined();
  });

  test("semantically-corrupt state is ignored: verdict disagrees with findings", async () => {
    const deps = memDeps();
    // verdict:"approve" alongside a must-fix would make sticky-approve suppress a
    // real block. Must be rejected (→ undefined).
    const inconsistent = {
      version: 1,
      results: {
        claude: { reviewer: "claude", verdict: "approve", findings: [{ lens: "c", file: "f", line: 1, severity: "must-fix", finding: "x" }] },
        codex: { reviewer: "codex", verdict: "approve", findings: [] },
      },
    };
    deps.files.set("/state/s.json", JSON.stringify(inconsistent));
    expect(await createSessionStore(deps).load("s")).toBeUndefined();
  });

  test("an unsafe session id is rejected before any FS access (path traversal)", async () => {
    const deps = memDeps();
    const store = createSessionStore(deps);
    for (const bad of ["../etc", "a/b", "..", "$(x)", ""]) {
      await expect(store.load(bad)).rejects.toThrow("invalid session id");
      await expect(store.loadForCompare!(bad)).rejects.toThrow("invalid session id");
      await expect(store.save(bad, state)).rejects.toThrow("invalid session id");
      await expect(store.clear(bad)).rejects.toThrow("invalid session id");
    }
    expect(deps.files.size).toBe(0);
  });
});
