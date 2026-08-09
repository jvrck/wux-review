import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { SKILLS } from "../src/skills/embedded";
import { skillsCommand } from "../src/skills/show";

const root = new URL("..", import.meta.url).pathname;
const read = (rel: string) => readFileSync(`${root}${rel}`, "utf8");

describe("skill generation (no drift)", () => {
  const source = read("skills/wux-review/SKILL.md");

  test("both portable forms are byte-identical to the single source", () => {
    expect(read(".claude/skills/wux-review/SKILL.md")).toBe(source);
    expect(read(".agents/skills/wux-review/SKILL.md")).toBe(source);
  });

  test("the embedded copy matches the source", () => {
    expect(SKILLS["wux-review"]).toBe(source);
  });
});

describe("skill content", () => {
  const source = read("skills/wux-review/SKILL.md");

  test("invokes the wux-review CLI and does not re-implement review logic", () => {
    expect(source).toContain("wux-review");
    expect(source).toContain("--json");
    // It is a thin wrapper: it must not reach into the internal functions.
    // (camelCase identifiers that would never appear in user-facing prose —
    // unlike the word "consolidated", which legitimately describes the verdict.)
    for (const internal of ["runReviewers", "resolveLenses", "getDiff", "parseReport"]) {
      expect(source).not.toContain(internal);
    }
  });

  test("is explicit-only and stops at the human merge gate", () => {
    expect(source).toContain("disable-model-invocation");
    expect(source.toLowerCase()).toContain("merge gate");
    expect(source.toLowerCase()).toContain("do not merge");
  });

  test("documents exit 2 as a blocked review with JSON preserved", () => {
    expect(source).toContain("Exit `2` means **review blocked**");
    expect(source).toContain("review-blocked");
    expect(source).toContain("json.load");
  });
});

describe("skillsCommand", () => {
  test("show <name> returns the embedded skill", () => {
    expect(skillsCommand(["show", "wux-review"])).toBe(SKILLS["wux-review"]);
  });

  test("errors on an unknown subcommand, missing name, unknown skill, or trailing args", () => {
    expect(() => skillsCommand(["list"])).toThrow("unknown skills subcommand");
    expect(() => skillsCommand(["show"])).toThrow("requires a skill name");
    expect(() => skillsCommand(["show", "nope"])).toThrow("unknown skill: nope");
    expect(() => skillsCommand(["show", "wux-review", "extra"])).toThrow("single skill name");
  });
});
