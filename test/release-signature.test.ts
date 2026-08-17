import { describe, expect, test } from "bun:test";
import {
  closeSync,
  copyFileSync,
  mkdtempSync,
  openSync,
  readFileSync,
  readSync,
  rmSync,
  writeSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = fileURLToPath(new URL("..", import.meta.url));
const VERIFY_SCRIPT = join(REPO_ROOT, "scripts", "verify-darwin-signature.sh");
const RELEASE_WORKFLOW = join(REPO_ROOT, ".github", "workflows", "release.yml");
const MANUAL_WORKFLOW = join(REPO_ROOT, ".github", "workflows", "validate-release.yml");

function run(command: string[]) {
  return Bun.spawnSync(command, { cwd: REPO_ROOT, stdout: "pipe", stderr: "pipe" });
}

describe("Darwin release signature gate", () => {
  test("verification script parses as shell", () => {
    expect(run(["bash", "-n", VERIFY_SCRIPT]).exitCode).toBe(0);
  });

  test("workflows use the shared fail-closed check at the required ordering points", () => {
    const release = readFileSync(RELEASE_WORKFLOW, "utf8");
    const manual = readFileSync(MANUAL_WORKFLOW, "utf8");

    const sign = release.indexOf('/usr/bin/codesign --force --sign - "$asset_path"');
    const firstVerify = release.indexOf('scripts/verify-darwin-signature.sh "$asset_path"');
    const upload = release.indexOf('gh release upload "$TAG" "dist/${{ matrix.asset }}"');
    const checksums = release.indexOf("- name: Create SHA256SUMS");

    expect(release).toContain("runs-on: ${{ matrix.os }}");
    expect(release).toContain("asset: wux-review-darwin-arm64\n            os: macos-15");
    expect(sign).toBeGreaterThan(-1);
    expect(firstVerify).toBeGreaterThan(sign);
    expect(upload).toBeGreaterThan(firstVerify);
    expect(checksums).toBeGreaterThan(upload);
    expect(release).toContain("needs: [validate-native, validate-linux-musl]");
    const draftDownload = release.indexOf("- name: Download release asset from draft");
    const draftVerify = release.indexOf(
      'scripts/verify-darwin-signature.sh "$RUNNER_TEMP/release-assets/$ASSET/$ASSET"',
    );
    const runtimeVerify = release.indexOf("- name: Verify build artifact");
    expect(draftDownload).toBeGreaterThan(upload);
    expect(draftVerify).toBeGreaterThan(draftDownload);
    expect(runtimeVerify).toBeGreaterThan(draftVerify);
    const manualChecksum = manual.indexOf("shasum -a 256 -c SHA256SUMS.one");
    const manualVerify = manual.indexOf(
      'scripts/verify-darwin-signature.sh "${{ steps.release.outputs.asset_dir }}/$ASSET"',
    );
    const manualRuntime = manual.indexOf("- name: Verify version and smoke");
    expect(manualChecksum).toBeGreaterThan(-1);
    expect(manualVerify).toBeGreaterThan(manualChecksum);
    expect(manualRuntime).toBeGreaterThan(manualVerify);
  });

  test.skipIf(process.platform !== "darwin")(
    "accepts an explicitly signed Mach-O and rejects the same bytes after tampering",
    () => {
      const root = mkdtempSync(join(tmpdir(), "wuxr-darwin-signature-"));
      const asset = join(root, "wux-review-darwin-arm64");
      try {
        copyFileSync("/bin/echo", asset);
        const sign = run(["/usr/bin/codesign", "--force", "--sign", "-", asset]);
        expect(sign.exitCode).toBe(0);

        const valid = run(["bash", VERIFY_SCRIPT, asset]);
        expect(valid.exitCode).toBe(0);
        expect(valid.stdout.toString()).toContain("verification passed");

        const handle = openSync(asset, "r+");
        try {
          const byte = Buffer.alloc(1);
          expect(readSync(handle, byte, 0, 1, 4096)).toBe(1);
          byte[0] ^= 0xff;
          expect(writeSync(handle, byte, 0, 1, 4096)).toBe(1);
        } finally {
          closeSync(handle);
        }

        const invalid = run(["bash", VERIFY_SCRIPT, asset]);
        expect(invalid.exitCode).toBe(1);
        expect(invalid.stderr.toString()).toContain("Darwin signature verification failed");
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    },
  );
});
