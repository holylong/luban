import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { compiledCliEntry, resolveCliPath } from "./cli-entry.js";

const dirs: string[] = [];
function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "luban-cli-entry-"));
  dirs.push(dir);
  return dir;
}
afterEach(() => {
  while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true });
});

/** npm's bin directory: `bin/luban` is a link, the script is dist/cli.js. */
function npmStyleInstall(): { bin: string; cli: string } {
  const root = tempDir();
  const dist = join(root, "lib", "node_modules", "luban", "dist");
  mkdirSync(dist, { recursive: true });
  const cli = join(dist, "cli.js");
  writeFileSync(cli, "#!/usr/bin/env node\n");
  const bin = join(root, "bin");
  mkdirSync(bin);
  symlinkSync(cli, join(bin, "luban"));
  return { bin: join(bin, "luban"), cli };
}

describe("cli entry resolution", () => {
  it("follows a symlinked launcher to the compiled CLI", () => {
    const { bin, cli } = npmStyleInstall();
    // Node hands us whatever the shell ran: …/bin/luban has no .js extension,
    // which used to read as "not a compiled CLI" and broke every daemon start.
    expect(resolveCliPath(bin)).toBe(cli);
    expect(compiledCliEntry(bin)).toBe(cli);
  });

  it("follows a chain of links and a relative link", () => {
    const { bin, cli } = npmStyleInstall();
    const alias = join(tempDir(), "luban-alias");
    symlinkSync(bin, alias);
    expect(compiledCliEntry(alias)).toBe(cli);
  });

  it("keeps accepting a plain compiled path", () => {
    const { cli } = npmStyleInstall();
    expect(compiledCliEntry(cli)).toBe(cli);
  });

  it("still refuses a dev loader or no entry at all", () => {
    expect(compiledCliEntry("/opt/luban/src/cli.tsx")).toBeUndefined();
    expect(compiledCliEntry("")).toBeUndefined();
    // `undefined` means "the file running right now": that default is what the
    // daemon and the bot worker rely on, so it must not resolve to nothing.
    expect(compiledCliEntry(undefined)).toBe(compiledCliEntry(process.argv[1]));
  });

  it("leaves an unresolvable path alone instead of dropping it", () => {
    expect(resolveCliPath("/nowhere/luban")).toBe("/nowhere/luban");
    expect(compiledCliEntry("/nowhere/luban")).toBeUndefined();
  });
});
