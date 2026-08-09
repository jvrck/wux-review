import { describe, expect, test } from "bun:test";
import {
  MACHINE_EVENT_PARSE_LIMIT_BYTES,
  MachineEventParser,
  machineStreamChunkRecord,
} from "../../src/backends/observable-events";

function split(bytes: Uint8Array, points: number[]): Uint8Array[] {
  const chunks: Uint8Array[] = [];
  let offset = 0;
  for (const point of points) {
    chunks.push(bytes.subarray(offset, point));
    offset = point;
  }
  chunks.push(bytes.subarray(offset));
  return chunks.filter((chunk) => chunk.byteLength > 0);
}

describe("observable machine-event capture", () => {
  test("base64 chunk records reconstruct raw JSONL byte-for-byte across partial writes", async () => {
    const raw = await Bun.file(
      new URL("../fixtures/observable/claude-stream.jsonl", import.meta.url),
    ).bytes();
    const chunks = split(raw, [1, 17, 63, 64, 151, raw.byteLength - 1]);
    let offset = 0;
    const records = chunks.map((bytes, index) => {
      const record = machineStreamChunkRecord({
        at: `2026-07-28T00:00:0${index}Z`,
        reviewer: "claude",
        offset,
        bytes,
      });
      offset += bytes.byteLength;
      return record;
    });
    const reconstructed = Buffer.concat(
      records.map((record) => Buffer.from(record.data, "base64")),
    );
    expect(reconstructed.equals(Buffer.from(raw))).toBe(true);
    expect(records.map((record) => record.offset)).toEqual(
      records.map((_, index) => chunks.slice(0, index).reduce((n, chunk) => n + chunk.byteLength, 0)),
    );
  });

  test("partial, malformed, unknown, CRLF, and unterminated lines are safe and non-approving", () => {
    const parser = new MachineEventParser("codex");
    const first = new TextEncoder().encode(
      '{"type":"thread.started","thread_id":"secret"}\r\n{"type":"item.started","item":{"type":"command_',
    );
    const second = new TextEncoder().encode(
      'execution","command":"TOKEN_SECRET"}}\n{malformed\n{"type":"future.secret","payload":"TOKEN"}',
    );

    const one = parser.push(first);
    expect(one).toHaveLength(1);
    expect(one[0]!.observation.latestActivity).toBe("session initialized");

    const two = parser.push(second);
    expect(two).toHaveLength(2);
    expect(two[0]!.observation.latestActivity).toBe("shell tool started");
    expect(two[1]!.diagnostic?.kind).toBe("malformed");

    const final = parser.finish();
    expect(final).toHaveLength(1);
    expect(final[0]!.diagnostic?.kind).toBe("unknown");
    expect(JSON.stringify([...one, ...two, ...final])).not.toContain("TOKEN_SECRET");
  });

  test("oversized lines are retained by raw capture but skipped by bounded parsing", () => {
    const raw = new TextEncoder().encode(
      `{"type":"item.started","item":{"type":"command_execution","command":"${"x".repeat(MACHINE_EVENT_PARSE_LIMIT_BYTES)}"}}\n`,
    );
    const record = machineStreamChunkRecord({
      at: "2026-07-28T00:00:00Z",
      reviewer: "codex",
      offset: 0,
      bytes: raw,
    });
    expect(Buffer.from(record.data, "base64").equals(Buffer.from(raw))).toBe(true);

    const parser = new MachineEventParser("codex");
    const parsed = parser.push(raw);
    expect(parsed).toEqual([{
      observation: {},
      diagnostic: { kind: "oversized" },
    }]);
  });

  test("CRLF framing does not consume the exact safe-activity parse limit", () => {
    const empty = JSON.stringify({
      type: "item.started",
      item: { type: "command_execution", command: "" },
    });
    const json = JSON.stringify({
      type: "item.started",
      item: {
        type: "command_execution",
        command: "x".repeat(
          MACHINE_EVENT_PARSE_LIMIT_BYTES - Buffer.byteLength(empty),
        ),
      },
    });
    expect(Buffer.byteLength(json)).toBe(MACHINE_EVENT_PARSE_LIMIT_BYTES);
    const parsed = new MachineEventParser("codex")
      .push(Buffer.from(`${json}\r\n`));
    expect(parsed).toHaveLength(1);
    expect(parsed[0]!.observation.latestActivity).toBe("shell tool started");
    expect(parsed[0]!.diagnostic).toBeUndefined();
  });

  test("CRLF framing still rejects safe activity above the parse limit", () => {
    const empty = JSON.stringify({
      type: "item.started",
      item: { type: "command_execution", command: "" },
    });
    const json = JSON.stringify({
      type: "item.started",
      item: {
        type: "command_execution",
        command: "x".repeat(
          MACHINE_EVENT_PARSE_LIMIT_BYTES - Buffer.byteLength(empty) + 1,
        ),
      },
    });
    expect(new MachineEventParser("codex").push(Buffer.from(`${json}\r\n`)))
      .toEqual([{
        observation: {},
        diagnostic: { kind: "oversized" },
      }]);
  });

  test("blank and whitespace-only padding lines are ignored without diagnostics", () => {
    const parser = new MachineEventParser("claude");
    expect(parser.push(new TextEncoder().encode("\n \t\r\n"))).toEqual([]);
    expect(parser.push(new TextEncoder().encode("  "))).toEqual([]);
    expect(parser.finish()).toEqual([]);
  });

  test("Claude retains only its last bounded result event for atomic verdict publication", () => {
    const parser = new MachineEventParser("claude");
    const stale = JSON.stringify({
      type: "result",
      is_error: false,
      result: "STALE_RESULT",
    });
    const final = JSON.stringify({
      type: "result",
      is_error: false,
      result: "FINAL_RESULT",
    });
    parser.push(new TextEncoder().encode([
      JSON.stringify({ type: "system", subtype: "init" }),
      stale,
      JSON.stringify({ type: "assistant", message: { content: [] } }),
      final,
      "",
    ].join("\n")));
    expect(parser.finalResultEvent()).toBe(final);
  });

  test("Claude result extraction has a larger bound than safe activity parsing", () => {
    const parser = new MachineEventParser("claude");
    const result = JSON.stringify({
      type: "result",
      is_error: false,
      result: "x".repeat(MACHINE_EVENT_PARSE_LIMIT_BYTES + 1),
    });
    expect(parser.push(new TextEncoder().encode(`${result}\n`))).toEqual([{
      observation: {},
      diagnostic: { kind: "oversized" },
    }]);
    expect(parser.finalResultEvent()).toBe(result);
  });

  test("CRLF framing does not consume Claude's exact result byte limit", () => {
    const resultLimit = 128;
    const empty = JSON.stringify({
      type: "result",
      is_error: false,
      result: "",
    });
    const result = JSON.stringify({
      type: "result",
      is_error: false,
      result: "x".repeat(resultLimit - Buffer.byteLength(empty)),
    });
    expect(Buffer.byteLength(result)).toBe(resultLimit);

    const parser = new MachineEventParser("claude", 32, resultLimit);
    parser.push(Buffer.from(`${result}\r`));
    parser.push(Buffer.from("\n"));
    expect(parser.finalResultEvent()).toBe(result);
  });

  test("CRLF framing still rejects a Claude result above its byte limit", () => {
    const resultLimit = 128;
    const empty = JSON.stringify({
      type: "result",
      is_error: false,
      result: "",
    });
    const oversized = JSON.stringify({
      type: "result",
      is_error: false,
      result: "x".repeat(resultLimit - Buffer.byteLength(empty) + 1),
    });
    const parser = new MachineEventParser("claude", 32, resultLimit);
    parser.push(Buffer.from(`${oversized}\r\n`));
    expect(parser.finalResultEvent()).toBeUndefined();
  });

  test("an unclassifiably large later Claude line invalidates a cached result", () => {
    const parser = new MachineEventParser("claude", 512, 128);
    const stale = JSON.stringify({
      type: "result",
      is_error: false,
      result: "STALE_RESULT",
    });
    const oversized = JSON.stringify({
      type: "result",
      is_error: false,
      result: "x".repeat(256),
    });
    parser.push(new TextEncoder().encode(`${stale}\n`));
    expect(parser.finalResultEvent()).toBe(stale);
    parser.push(new TextEncoder().encode(`${oversized}\n`));
    expect(parser.finalResultEvent()).toBeUndefined();
  });

  test("large Claude result segments are stable when a caller reuses its read buffer", () => {
    const parser = new MachineEventParser("claude", 8, 1024);
    const result = JSON.stringify({
      type: "result",
      is_error: false,
      result: "FINAL_RESULT_FROM_REUSED_BUFFER",
    });
    const bytes = Buffer.from(`${result}\n`);
    const reusable = Buffer.alloc(16);
    for (let offset = 0; offset < bytes.byteLength; offset += reusable.byteLength) {
      const length = Math.min(reusable.byteLength, bytes.byteLength - offset);
      bytes.copy(reusable, 0, offset, offset + length);
      parser.push(reusable.subarray(0, length));
      reusable.fill(0xff);
    }
    expect(parser.finalResultEvent()).toBe(result);
  });

  test("bounded line segments are stable when a caller reuses its read buffer", () => {
    const parser = new MachineEventParser("claude", 1024, 2048);
    const result = JSON.stringify({
      type: "result",
      is_error: false,
      result: "FINAL_RESULT_FROM_REUSED_BUFFER",
    });
    const bytes = Buffer.from(`${result}\n`);
    const reusable = Buffer.alloc(16);
    for (let offset = 0; offset < bytes.byteLength; offset += reusable.byteLength) {
      const length = Math.min(reusable.byteLength, bytes.byteLength - offset);
      bytes.copy(reusable, 0, offset, offset + length);
      parser.push(reusable.subarray(0, length));
      reusable.fill(0xff);
    }
    expect(parser.finalResultEvent()).toBe(result);
  });
});
