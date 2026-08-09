export {};

const [reviewer, ...args] = Bun.argv.slice(2);
const targetRepo = process.env.WUX_REVIEW_FIXTURE_REPO!;
const markerDir = process.env.WUX_REVIEW_FIXTURE_MARKERS!;
const report = '```json\n{"findings":[]}\n```';

async function mark(name: string) {
  await Bun.write(`${markerDir}/${name}`, "invoked\n");
}

if (reviewer === "claude") {
  const prompt = await new Response(Bun.stdin.stream()).text();
  if (
    process.cwd() === targetRepo
    || await Bun.file(`${process.cwd()}/AGENTS.md`).exists()
  ) await mark("project-instructions");
  if (!args.includes("--safe-mode")) await mark("hook-or-plugin");
  if (!args.includes("--strict-mcp-config")) await mark("mcp");
  if (!args.includes("--disable-slash-commands")) await mark("skill");
  const tools = args.indexOf("--tools");
  if (tools < 0 || args[tools + 1] !== "") {
    await mark("built-in-tool");
    if (prompt.includes("overwrite owned.txt")) await Bun.write(`${targetRepo}/owned.txt`, "MUTATED\n");
  }
  process.stdout.write(JSON.stringify({
    type: "result",
    subtype: "success",
    is_error: false,
    result: report,
  }));
  process.exit(0);
}

if (reviewer === "codex") {
  const home = process.env.CODEX_HOME!;
  const configPath = `${home}/config.toml`;
  const config = await Bun.file(configPath).exists()
    ? Bun.TOML.parse(await Bun.file(configPath).text()) as Record<string, unknown>
    : {};
  for (const key of ["notify", "hooks", "plugins", "skills", "mcp_servers", "tools", "instructions"]) {
    if (config[key] !== undefined) await mark(key);
  }
  if (
    process.cwd() === targetRepo
    || args[args.indexOf("-C") + 1] === targetRepo
    || await Bun.file(`${process.cwd()}/AGENTS.md`).exists()
  ) {
    await mark("project-instructions");
  }
  if (!args.includes("--ignore-rules")) await mark("rules");
  const sandbox = args.indexOf("-s");
  const output = args.indexOf("-o");
  const promptArg = args.at(-1) ?? "";
  const promptPath = promptArg.match(/brief at (.+) and follow/)?.[1];
  const prompt = promptPath === undefined ? "" : await Bun.file(promptPath).text();
  if ((sandbox < 0 || args[sandbox + 1] !== "read-only") && prompt.includes("overwrite owned.txt")) {
    await mark("write-path");
    await Bun.write(`${targetRepo}/owned.txt`, "MUTATED\n");
  }
  await Bun.write(args[output + 1]!, report);
  process.exit(0);
}

throw new Error(`unexpected reviewer: ${reviewer}`);
