import { describe, expect, test } from "bun:test";
import { parseConfig } from "../../src/review/config";

describe("parseConfig", () => {
  test("an empty document is the empty config", () => {
    expect(parseConfig("")).toEqual({});
    expect(parseConfig("# just a comment\n")).toEqual({});
  });

  test("parses lenses, extra_lenses, and reviewer model pinning", () => {
    const yaml = `
lenses:
  - correctness
  - does-it-deploy
extra_lenses:
  - name: does-it-deploy
    prompt: Does it deploy cleanly?
reviewers:
  claude:
    model: claude-opus-4-8
  codex:
    model: gpt-5.4
`;
    expect(parseConfig(yaml)).toEqual({
      lenses: ["correctness", "does-it-deploy"],
      extraLenses: [{ name: "does-it-deploy", prompt: "Does it deploy cleanly?" }],
      reviewers: { claude: { model: "claude-opus-4-8" }, codex: { model: "gpt-5.4" } },
    });
  });

  test("normalizes a string check to a one-element command list", () => {
    expect(parseConfig("check: pytest -q\n")).toEqual({ check: ["pytest -q"] });
  });

  test("keeps an array check as an ordered command list", () => {
    expect(parseConfig("check:\n  - ruff check\n  - pytest -q\n")).toEqual({ check: ["ruff check", "pytest -q"] });
  });

  test("omits check entirely when absent (so the default applies)", () => {
    expect(parseConfig("lenses:\n  - correctness\n").check).toBeUndefined();
  });

  test("rejects an empty check list, an empty string, or a blank (whitespace-only) command", () => {
    expect(() => parseConfig("check: []\n")).toThrow(".wux-review.yml");
    expect(() => parseConfig('check: ""\n')).toThrow(".wux-review.yml");
    expect(() => parseConfig('check: "   "\n')).toThrow(".wux-review.yml"); // would be a no-op gate
    expect(() => parseConfig('check:\n  - "pytest -q"\n  - "  "\n')).toThrow(".wux-review.yml");
  });

  test("trims surrounding whitespace from a check command", () => {
    expect(parseConfig('check: "  pytest -q  "\n')).toEqual({ check: ["pytest -q"] });
  });

  test("rejects an unknown top-level key", () => {
    expect(() => parseConfig("bogus: true\n")).toThrow(".wux-review.yml");
  });

  test("rejects a wrong-typed lenses value", () => {
    expect(() => parseConfig("lenses: not-a-list\n")).toThrow(".wux-review.yml");
  });

  test("rejects an explicitly empty lenses list", () => {
    expect(() => parseConfig("lenses: []\n")).toThrow(".wux-review.yml");
  });

  test("rejects an extra lens missing its prompt", () => {
    expect(() => parseConfig("extra_lenses:\n  - name: x\n")).toThrow(".wux-review.yml");
  });

  test("rejects unknown keys in nested schemas (strict throughout)", () => {
    expect(() => parseConfig("extra_lenses:\n  - name: x\n    prompt: y\n    bogus: 1\n")).toThrow(
      ".wux-review.yml",
    );
    expect(() => parseConfig("reviewers:\n  claude:\n    modle: m\n")).toThrow(".wux-review.yml");
    expect(() => parseConfig("reviewers:\n  other: {}\n")).toThrow(".wux-review.yml");
  });

  test("surfaces invalid YAML as a clean error", () => {
    expect(() => parseConfig("lenses: [unterminated\n")).toThrow("invalid YAML");
  });
});
