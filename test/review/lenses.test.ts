import { describe, expect, test } from "bun:test";
import { DEFAULT_LENSES, resolveLenses } from "../../src/review/lenses";
import { buildReviewerPrompt } from "../../src/review/prompt";

const names = (lenses: { name: string }[]) => lenses.map((l) => l.name);

describe("resolveLenses", () => {
  test("defaults to the v1 set of five lenses", () => {
    expect(names(resolveLenses())).toEqual([
      "correctness",
      "edge-cases",
      "security",
      "regression",
      "clarity",
    ]);
    expect(DEFAULT_LENSES.every((l) => l.prompt.length > 0)).toBe(true);
  });

  test("--lenses overrides the set", () => {
    expect(names(resolveLenses({ cliLenses: ["security", "correctness"] }))).toEqual([
      "security",
      "correctness",
    ]);
  });

  test(".wux-review.yml lenses override the default when no --lenses", () => {
    expect(names(resolveLenses({ config: { lenses: ["clarity"] } }))).toEqual(["clarity"]);
  });

  test('the "default" alias expands to the unchanged default set', () => {
    expect(resolveLenses({ cliLenses: ["default"] })).toEqual(DEFAULT_LENSES);
    expect(buildReviewerPrompt("diff", resolveLenses({ cliLenses: ["default"] }))).toBe(
      buildReviewerPrompt("diff", DEFAULT_LENSES),
    );
  });

  test('the "default" alias works in config lenses and de-duplicates expanded names', () => {
    expect(names(resolveLenses({ config: { lenses: ["default", "security"] } }))).toEqual(
      names(DEFAULT_LENSES),
    );
  });

  test('the "default" alias can be followed by an extra lens', () => {
    const config = { extraLenses: [{ name: "does-it-deploy", prompt: "Does it deploy cleanly?" }] };
    expect(names(resolveLenses({ cliLenses: ["default", "does-it-deploy"], config }))).toEqual([
      ...names(DEFAULT_LENSES),
      "does-it-deploy",
    ]);
  });

  test("an explicitly empty lens set is rejected, not silently defaulted", () => {
    expect(() => resolveLenses({ cliLenses: [] })).toThrow("no lenses resolved");
    expect(() => resolveLenses({ config: { lenses: [] } })).toThrow("no lenses resolved");
  });

  test("--lenses wins over config lenses (precedence)", () => {
    expect(
      names(resolveLenses({ cliLenses: ["security"], config: { lenses: ["clarity"] } })),
    ).toEqual(["security"]);
  });

  test("extra_lenses extend the registry and can be selected", () => {
    const config = {
      lenses: ["correctness", "does-it-deploy"],
      extraLenses: [{ name: "does-it-deploy", prompt: "Does it deploy cleanly?" }],
    };
    const resolved = resolveLenses({ config });
    expect(names(resolved)).toEqual(["correctness", "does-it-deploy"]);
    expect(resolved[1]!.prompt).toBe("Does it deploy cleanly?");
  });

  test("extra_lenses can override a default lens's prompt", () => {
    const resolved = resolveLenses({
      cliLenses: ["security"],
      config: { extraLenses: [{ name: "security", prompt: "Custom security prompt" }] },
    });
    expect(resolved[0]!.prompt).toBe("Custom security prompt");
  });

  test("an unknown lens name is a clean error that lists all valid names", () => {
    expect(() => resolveLenses({ cliLenses: ["bogus"] })).toThrow(
      "unknown lens: bogus (valid: default, correctness, edge-cases, security, regression, clarity; define new lenses under extra_lenses in .wux-review.yml)",
    );
    expect(() => resolveLenses({ cliLenses: ["bogus"], config: { extraLenses: [{ name: "custom", prompt: "x" }] } })).toThrow(
      "valid: default, correctness, edge-cases, security, regression, clarity, custom",
    );
  });

  test("duplicate names are de-duplicated", () => {
    expect(names(resolveLenses({ cliLenses: ["security", "security", "clarity"] }))).toEqual([
      "security",
      "clarity",
    ]);
  });
});
