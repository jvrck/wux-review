import { WuxReviewError } from "../runtime/errors";
import { SKILLS } from "./embedded";

// `wux-review skills show <name>` prints a bundled skill's SKILL.md. The skill
// is embedded in the binary so `install.sh --with-skills` can extract it on a
// host with no repo checkout.
export function skillsCommand(argv: string[]): string {
  const [sub, name, ...rest] = argv;
  if (sub !== "show") {
    throw new WuxReviewError(`unknown skills subcommand: ${sub ?? "(none)"} (try: skills show <name>)`);
  }
  if (name === undefined) {
    throw new WuxReviewError("skills show requires a skill name");
  }
  if (rest.length > 0) {
    throw new WuxReviewError(`skills show takes a single skill name (unexpected: ${rest.join(" ")})`);
  }
  const content = SKILLS[name];
  if (content === undefined) {
    throw new WuxReviewError(`unknown skill: ${name} (available: ${Object.keys(SKILLS).join(", ")})`);
  }
  return content;
}
