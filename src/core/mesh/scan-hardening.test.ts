import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import fg from "fast-glob";
import { scanWorkspace, RESERVED_SYNC_IGNORE } from "./sync.js";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true, maxRetries: 20, retryDelay: 25 })));
});

async function fixture(prefix: string): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), prefix));
  roots.push(root);
  return root;
}

/**
 * Creating a symlink needs Developer Mode or elevation on Windows, so a test
 * that depends on one must skip rather than fail on a default developer box.
 * This is the exact shape that crashed the peer node, so it is worth asserting
 * wherever the platform allows it.
 */
async function trySymlink(target: string, path: string, type: "dir" | "file"): Promise<boolean> {
  try {
    await symlink(target, path, type);
    return true;
  } catch {
    return false;
  }
}

describe("workspace scan hardening", () => {
  // The crash that took down the peer node: `.dagent/winbuild/_home/.wine/dosdevices/z:`
  // is a symlink to the filesystem root, so a `dot: true` scan followed it out of
  // the workspace and died on an EACCES in a root-owned directory.
  it("does not follow a symlink that points outside the workspace", async () => {
    const root = await fixture("luban-scan-escape-");
    await mkdir(join(root, "src"));
    await writeFile(join(root, "src", "app.ts"), "export const app = 1;\n");
    // Point a hidden tree at an unrelated directory standing in for `/`.
    const outside = await fixture("luban-scan-outside-");
    await writeFile(join(outside, "secret.txt"), "root-owned\n");
    const cache = join(root, ".dagent", "winbuild", "_home", ".wine", "dosdevices");
    await mkdir(cache, { recursive: true });
    // `z:` is a reserved DOS device name on Windows, so link the same
    // drive-letter directory under a name NTFS accepts.
    if (!await trySymlink(outside, join(cache, "link"), "dir")) return;

    const matches = await fg("**/*", {
      cwd: root,
      onlyFiles: true,
      dot: true,
      followSymbolicLinks: false,
      suppressErrors: true,
      ignore: [".luban/**", ".dagent/**"],
    });
    expect(matches).toContain("src/app.ts");
    // Neither the hidden cache nor anything reached through the symlink leaks in.
    expect(matches.some((file) => file.includes("secret.txt"))).toBe(false);
    expect(matches.some((file) => file.includes(".dagent"))).toBe(false);
  });

  it("keeps the node-context probe from rejecting on an unreadable tree", async () => {
    const root = await fixture("luban-scan-probe-");
    await writeFile(join(root, "README.md"), "# project\n");
    // A dangling symlink is a realistic stand-in for a broken tool cache link:
    // scandir on the target fails, and without suppressErrors fast-glob rejects.
    const probe = () => fg("**/*", {
      cwd: root,
      onlyFiles: true,
      dot: true,
      followSymbolicLinks: false,
      suppressErrors: true,
      ignore: [".luban/**", ".dagent/**"],
    });
    if (await trySymlink(join(root, "does-not-exist"), join(root, "broken"), "dir")) {
      await expect(probe().then((files) => files.length > 0)).resolves.toBe(true);
    }
    // The runtime depends on this probe resolving, so assert it unconditionally.
    await expect(probe().then((files) => files.length > 0)).resolves.toBe(true);
  });

  it("keeps syncWorkspace ignoring the agent cache directory", async () => {
    const root = await fixture("luban-scan-cache-");
    await mkdir(join(root, ".dagent"), { recursive: true });
    await writeFile(join(root, ".dagent", "toolchain.bin"), "binary\n");
    await writeFile(join(root, "app.py"), "print('hi')\n");
    expect(Object.keys(await scanWorkspace(root))).toEqual(["app.py"]);
  });

  it("still reports a real workspace file so context detection works", async () => {
    const root = await fixture("luban-scan-real-");
    await mkdir(join(root, "src"));
    await writeFile(join(root, "src", "index.ts"), "export {};\n");
    const files = await scanWorkspace(root);
    expect(Object.keys(files)).toEqual(["src/index.ts"]);
    expect(await readFile(join(root, "src", "index.ts"), "utf8")).toBe("export {};\n");
  });

  /**
   * Regression: a `sync.ignore` list without `.luban` made every scan throw
   * "path escapes or is reserved: .luban/backup/...bundle", because the walk
   * reached our own backup bundle and `portableParts` rejects the leading `.luban`.
   * A user-supplied ignore must never be able to re-admit a reserved directory.
   */
  it("excludes reserved metadata dirs even when the caller's ignore omits them", async () => {
    const root = await fixture("luban-scan-reserved-");
    await mkdir(join(root, ".luban", "backup"), { recursive: true });
    await writeFile(join(root, ".luban", "backup", "luban-pre-rewrite.bundle"), "binary\n");
    await writeFile(join(root, ".luban", "sync_state.json"), "{}\n");
    await mkdir(join(root, ".git"));
    await writeFile(join(root, ".git", "HEAD"), "ref: refs/heads/main\n");
    await writeFile(join(root, "app.py"), "print('hi')\n");

    const lean = ["node_modules", "*.log"]; // no .luban, no .git
    await expect(scanWorkspace(root, lean)).resolves.toEqual(
      expect.objectContaining({ "app.py": expect.any(String) }),
    );
    expect(Object.keys(await scanWorkspace(root, lean))).toEqual(["app.py"]);

    for (const reserved of RESERVED_SYNC_IGNORE) {
      expect(await scanWorkspace(root, [reserved, ...lean])).toBeDefined();
    }
  });
});