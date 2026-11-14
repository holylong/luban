import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runMemory } from "./memory-command";
import { rememberFact } from "./memory";

/**
 * `luban memory` is the door the Creator window and a human on a terminal both
 * use. The important behaviours are "never guess what to delete" and "one
 * project never shows up in another's output".
 */
let home: string;
let first: string;
let second: string;
let output: string[];
const write = process.stdout.write.bind(process.stdout);

beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), "luban-memcmd-"));
  first = join(home, "first");
  second = join(home, "second");
  output = [];
  process.stdout.write = ((chunk: string) => { output.push(String(chunk)); return true; }) as typeof process.stdout.write;
});

afterEach(async () => {
  process.stdout.write = write;
  await rm(home, { recursive: true, force: true });
});

describe("luban memory", () => {
  it("lists every project with counts instead of dumping the file", async () => {
    await rememberFact(home, first, "禅道项目 id 是 42");
    await rememberFact(home, second, "用户偏好 pnpm");
    expect(await runMemory(["--home", home])).toBe(0);
    const text = output.join("");
    expect(text).toContain("first");
    expect(text).toContain("second");
    expect(text).toContain("事实 1");
  });

  it("emits JSON the window can render", async () => {
    await rememberFact(home, first, "禅道项目 id 是 42");
    expect(await runMemory(["--home", home, "--json"])).toBe(0);
    const rows = JSON.parse(output.join("")) as Array<{ workspace: string; facts: Array<{ text: string }> }>;
    expect(rows).toHaveLength(1);
    expect(rows[0]!.workspace).toBe(first);
    expect(rows[0]!.facts[0]!.text).toBe("禅道项目 id 是 42");
  });

  it("prints one project's Markdown when asked about a workspace", async () => {
    await rememberFact(home, first, "禅道项目 id 是 42");
    expect(await runMemory(["--home", home, first])).toBe(0);
    expect(output.join("")).toContain("禅道项目 id 是 42");
  });

  it("clears one project and leaves the other alone", async () => {
    await rememberFact(home, first, "禅道项目 id 是 42");
    await rememberFact(home, second, "用户偏好 pnpm");
    expect(await runMemory(["--home", home, "--clear", first])).toBe(0);
    output = [];
    expect(await runMemory(["--home", home, "--json"])).toBe(0);
    const rows = JSON.parse(output.join("")) as Array<{ workspace: string }>;
    expect(rows.map(row => row.workspace)).toEqual([second]);
  });

  it("refuses a bare --clear instead of picking a project", async () => {
    await rememberFact(home, first, "禅道项目 id 是 42");
    expect(await runMemory(["--home", home, "--clear"])).toBe(1);
    output = [];
    expect(await runMemory(["--home", home, "--json"])).toBe(0);
    expect(JSON.parse(output.join(""))).toHaveLength(1);
  });

  it("clears everything only when --all is explicit", async () => {
    await rememberFact(home, first, "禅道项目 id 是 42");
    await rememberFact(home, second, "用户偏好 pnpm");
    expect(await runMemory(["--home", home, "--clear", "--all"])).toBe(0);
    output = [];
    expect(await runMemory(["--home", home, "--json"])).toBe(0);
    expect(JSON.parse(output.join(""))).toEqual([]);
  });
});
