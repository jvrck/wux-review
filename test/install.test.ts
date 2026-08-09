import { describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const REPO_ROOT = new URL("..", import.meta.url).pathname;
const INSTALL_SH = join(REPO_ROOT, "install.sh");

function makeTempDir(prefix: string): string {
  return mkdtempSync(join(tmpdir(), prefix));
}

function isMuslRuntime(): boolean {
  if (process.platform !== "linux" || process.arch !== "x64") return false;
  const proc = Bun.spawnSync(["sh", "-c", "ldd --version 2>&1 || true"], {
    stdout: "pipe",
    stderr: "pipe",
  });
  return proc.stdout.toString().toLowerCase().includes("musl");
}

function assetName(): string {
  switch (process.platform) {
    case "darwin":
      if (process.arch === "arm64") return "wux-review-darwin-arm64";
      break;
    case "linux":
      if (process.arch === "arm64") return "wux-review-linux-arm64";
      if (process.arch === "x64") return isMuslRuntime() ? "wux-review-linux-x64-musl" : "wux-review-linux-x64";
      break;
  }
  throw new Error(`unsupported test platform: ${process.platform}/${process.arch}`);
}

function sha256Line(dir: string, fileName: string): string {
  const proc = Bun.spawnSync(["sh", "-c", `sha256sum "${fileName}" 2>/dev/null || shasum -a 256 "${fileName}"`], {
    stdout: "pipe",
    stderr: "pipe",
    cwd: dir,
  });
  if (proc.exitCode !== 0) {
    throw new Error(proc.stderr.toString() || "checksum command failed");
  }
  return proc.stdout.toString();
}

function writeFakeBinary(path: string): void {
  writeFileSync(
    path,
    `#!/usr/bin/env bash
set -euo pipefail
case "\${1:-}" in
  --version)
    printf '2026.06.13\\n'
    ;;
  --help)
    printf 'wux-review help\\n'
    ;;
  skills)
    shift
    [ "\${1:-}" = show ] || { printf 'unknown skills subcommand\\n' >&2; exit 1; }
    shift
    [ "\${1:-}" = wux-review ] || { printf 'unknown skill\\n' >&2; exit 1; }
    printf '# fake skill\\n'
    ;;
  *)
    printf 'unknown option: %s\\n' "\${1:-}" >&2
    exit 1
    ;;
esac
`,
  );
  chmodSync(path, 0o755);
}

function writeFakeCurl(path: string, releaseDir: string): void {
  writeFileSync(
    path,
    `#!/usr/bin/env bash
set -euo pipefail
out=
url=
while [ "$#" -gt 0 ]; do
  case "$1" in
    -o)
      out="$2"
      shift 2
      ;;
    -*)
      shift
      ;;
    *)
      url="$1"
      shift
      ;;
  esac
done
[ -n "$out" ] && [ -n "$url" ] || { printf 'fake curl: missing URL or output\\n' >&2; exit 1; }
case "$url" in
  https://github.com/jvrck/wux-review/releases/latest/download/*|https://github.com/jvrck/wux-review/releases/download/*)
    ;;
  *)
    printf 'unexpected curl URL: %s\\n' "$url" >&2
    exit 1
    ;;
esac
printf '%s\\n' "$url" >> "$CURL_LOG"
/bin/cp "${releaseDir}/\${url##*/}" "$out"
`,
  );
  chmodSync(path, 0o755);
}

function writeFakeCp(path: string): void {
  writeFileSync(
    path,
    [
      "#!/usr/bin/env bash",
      "set -euo pipefail",
      'if [ -n "${CP_LOG:-}" ]; then',
      "  printf '%s\\t%s\\n' \"$1\" \"$2\" >> \"$CP_LOG\"",
      "fi",
      'case "$2" in',
      '  "$BIN_DIR"/.wux-review.new.*)',
      '    if [ "${FAIL_STAGE_COPY:-0}" = 1 ]; then',
      "      printf 'injected staging copy failure\\n' >&2",
      "      exit 1",
      "    fi",
      "    ;;",
      "esac",
      "exec /bin/cp \"$@\"",
      "",
    ].join("\n"),
  );
  chmodSync(path, 0o755);
}

function writeFakeMv(path: string): void {
  writeFileSync(
    path,
    [
      "#!/usr/bin/env bash",
      "set -euo pipefail",
      'if [ "$1" = -f ]; then',
      "  shift",
      "fi",
      'if [ -n "${MV_LOG:-}" ]; then',
      "  printf '%s\\t%s\\n' \"$1\" \"$2\" >> \"$MV_LOG\"",
      "fi",
      "exec /bin/mv -f \"$@\"",
      "",
    ].join("\n"),
  );
  chmodSync(path, 0o755);
}

interface InstallFixture {
  root: string;
  releaseDir: string;
  binDir: string;
  skillsDir: string;
  curlLog: string;
  cpLog: string;
  mvLog: string;
  fakeBin: string;
}

function createFixture(): InstallFixture {
  const root = makeTempDir("wuxr-install-");
  const releaseDir = join(root, "release");
  const binDir = join(root, "bin");
  const skillsDir = join(root, "skills");
  const fakeBin = join(root, "fake-bin");
  const curlLog = join(root, "curl.log");
  const cpLog = join(root, "cp.log");
  const mvLog = join(root, "mv.log");
  mkdirSync(releaseDir);
  mkdirSync(fakeBin);

  const asset = assetName();
  writeFakeBinary(join(releaseDir, asset));
  writeFileSync(join(releaseDir, "SHA256SUMS"), sha256Line(releaseDir, asset));
  writeFakeCurl(join(fakeBin, "curl"), releaseDir);
  writeFakeCp(join(fakeBin, "cp"));
  writeFakeMv(join(fakeBin, "mv"));
  return { root, releaseDir, binDir, skillsDir, curlLog, cpLog, mvLog, fakeBin };
}

interface InstallResult {
  code: number;
  stdout: string;
  stderr: string;
}

async function runInstall(
  fixture: InstallFixture,
  args: string[],
  version = "latest",
  failStageCopy = false,
): Promise<InstallResult> {
  const proc = Bun.spawn(["bash", INSTALL_SH, ...args], {
    cwd: REPO_ROOT,
    stdout: "pipe",
    stderr: "pipe",
    env: {
      ...process.env,
      PATH: `${fixture.fakeBin}:${process.env.PATH ?? ""}`,
      BIN_DIR: fixture.binDir,
      WUX_REVIEW_SKILLS_DIR: fixture.skillsDir,
      WUX_REVIEW_REPO: "jvrck/wux-review",
      WUX_REVIEW_VERSION: version,
      CURL_LOG: fixture.curlLog,
      CP_LOG: fixture.cpLog,
      MV_LOG: fixture.mvLog,
      FAIL_STAGE_COPY: failStageCopy ? "1" : "0",
    },
  });
  const [stdout, stderr, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  return { code, stdout, stderr };
}

function expectReleaseUrls(fixture: InstallFixture, base: string): void {
  expect(readFileSync(fixture.curlLog, "utf8").trim().split("\n")).toEqual([
    `${base}/${assetName()}`,
    `${base}/SHA256SUMS`,
  ]);
}

function expectAtomicReplacement(fixture: InstallFixture): void {
  const [stagedFrom, stagedTo] = readFileSync(fixture.cpLog, "utf8").trim().split("\t");
  expect(stagedFrom).toContain(assetName());
  expect(stagedTo).toMatch(new RegExp("^" + fixture.binDir + "/\\.wux-review\\.new\\."));

  const [movedFrom, movedTo] = readFileSync(fixture.mvLog, "utf8").trim().split("\t");
  expect(movedFrom).toBe(stagedTo);
  expect(movedTo).toBe(join(fixture.binDir, "wux-review"));
}

describe("install.sh", () => {
  test("downloads and installs the latest release anonymously", async () => {
    const fixture = createFixture();
    try {
      const result = await runInstall(fixture, []);
      expect(result.code).toBe(0);
      expect(readFileSync(join(fixture.binDir, "wux-review"), "utf8")).toContain("2026.06.13");
      expect(result.stderr).toContain("installed");
      expect(result.stderr).not.toContain("unbound variable");
      expectReleaseUrls(fixture, "https://github.com/jvrck/wux-review/releases/latest/download");
      expectAtomicReplacement(fixture);
    } finally {
      rmSync(fixture.root, { recursive: true, force: true });
    }
  });

  test("downloads an explicit CalVer tag anonymously", async () => {
    const fixture = createFixture();
    try {
      const result = await runInstall(fixture, [], "2026.06.13.1");
      expect(result.code).toBe(0);
      expectReleaseUrls(fixture, "https://github.com/jvrck/wux-review/releases/download/2026.06.13.1");
    } finally {
      rmSync(fixture.root, { recursive: true, force: true });
    }
  });

  test("checksum failure preserves an existing binary", async () => {
    const fixture = createFixture();
    try {
      mkdirSync(fixture.binDir);
      const installed = join(fixture.binDir, "wux-review");
      writeFileSync(installed, "working binary\n");
      writeFileSync(join(fixture.releaseDir, assetName()), "corrupted release asset\n");

      const result = await runInstall(fixture, []);
      expect(result.code).not.toBe(0);
      expect(readFileSync(installed, "utf8")).toBe("working binary\n");
      expect(result.stderr).toMatch(/FAILED|NOT match|mismatch|checksum/i);
    } finally {
      rmSync(fixture.root, { recursive: true, force: true });
    }
  });

  test("staging failure after verification preserves the existing executable", async () => {
    const fixture = createFixture();
    try {
      mkdirSync(fixture.binDir);
      const installed = join(fixture.binDir, "wux-review");
      writeFileSync(installed, "#!/usr/bin/env bash\nprintf 'existing binary\\n'\n");
      chmodSync(installed, 0o755);

      const result = await runInstall(fixture, [], "latest", true);
      expect(result.code).not.toBe(0);
      expect(result.stderr).toContain("injected staging copy failure");
      expect(readFileSync(installed, "utf8")).toBe("#!/usr/bin/env bash\nprintf 'existing binary\\n'\n");
      expect(Bun.spawnSync([installed, "--version"], { stdout: "pipe" }).stdout.toString()).toBe("existing binary\n");
      expect(readFileSync(fixture.cpLog, "utf8")).toContain(fixture.binDir + "/.wux-review.new.");
      expect(existsSync(fixture.mvLog)).toBe(false);
    } finally {
      rmSync(fixture.root, { recursive: true, force: true });
    }
  });

  test("successful install with --with-skills writes SKILL.md", async () => {
    const fixture = createFixture();
    try {
      const result = await runInstall(fixture, ["--with-skills"]);
      expect(result.code).toBe(0);
      expect(readFileSync(join(fixture.skillsDir, "wux-review", "SKILL.md"), "utf8")).toBe("# fake skill\n");
      expect(result.stderr).toContain("installed skill");
      expect(result.stderr).not.toContain("unbound variable");
    } finally {
      rmSync(fixture.root, { recursive: true, force: true });
    }
  });
});
