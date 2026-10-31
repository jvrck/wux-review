import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";

const root = new URL("..", import.meta.url).pathname;
const templateDir = `${root}/.github/ISSUE_TEMPLATE`;
const guideUrl = "https://github.com/jvrck-labs/fspec/blob/main/docs/ISSUE_AUTHORING_GUIDE.md";
const headings = [
  "## Summary",
  "## Goal",
  "## Current State",
  "## Implementation Details",
  "## Files Likely Affected",
  "## Dependencies",
  "## Constraints/Non-Goals",
  "## Acceptance Criteria",
  "## Verification",
];

function read(name: string): string {
  return readFileSync(`${templateDir}/${name}`, "utf8");
}

function frontMatter(markdown: string): Record<string, unknown> {
  const match = /^---\n([\s\S]*?)\n---\n/.exec(markdown);
  if (!match) throw new Error("missing YAML front matter");
  return Bun.YAML.parse(match[1]!) as Record<string, unknown>;
}

describe("issue templates", () => {
  test("offer only Task, Bug, and Feature templates with blank issues disabled", () => {
    expect(readdirSync(templateDir).sort()).toEqual(["bug.md", "config.yml", "feature.md", "task.md"]);
    const config = Bun.YAML.parse(read("config.yml")) as {
      blank_issues_enabled: boolean;
      contact_links: Array<{ url: string }>;
    };
    expect(config.blank_issues_enabled).toBe(false);
    expect(config.contact_links.map((link) => link.url)).toContain(guideUrl);
    expect(config.contact_links.some((link) => /security/.test(link.url))).toBe(true);
  });

  test("each template has a typed title and the nine implementation-ready sections", () => {
    for (const name of ["task.md", "bug.md", "feature.md"]) {
      const markdown = read(name);
      const meta = frontMatter(markdown);
      expect(meta.name).toBeTruthy();
      expect(meta.about).toBeTruthy();
      expect(meta.title).toMatch(/^[a-z|]+: /);
      expect(markdown.split("\n").filter((line) => line.startsWith("## "))).toEqual(headings);
      expect(markdown).toContain("| File | Change |");
      expect(markdown).toContain("- [ ]");
      expect(markdown).toContain("```bash");
      expect(markdown).toContain(guideUrl);
      expect(markdown).not.toMatch(/\]\(\.?\/?docs\/ISSUE_AUTHORING_GUIDE\.md|Projects v2/);
    }
  });

  test("applies only the existing issue labels and keeps security reports private", () => {
    expect(frontMatter(read("bug.md")).labels).toBe("bug");
    expect(frontMatter(read("feature.md")).labels).toBe("enhancement");
    const contributing = readFileSync(`${root}/CONTRIBUTING.md`, "utf8");
    expect(contributing).toContain(guideUrl);
    expect(contributing).toContain("SECURITY.md");
  });
});
