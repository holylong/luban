import { describe, expect, it } from "vitest";
import { reloadPaths, sameTree } from "./desktop-tree";
import type { FileEntry } from "./types";

const file = (path: string, size = 10): FileEntry => ({ name: path.split("/").pop()!, path, type: "file", size });

describe("desktop file tree refresh", () => {
  it("reloads the root and every expanded folder, so new files appear", () => {
    const expanded = { src: true, "src/web": true, docs: false };
    expect(reloadPaths(expanded)).toEqual(["", "src", "src/web"]);
    expect(reloadPaths({})).toEqual([""]);
  });

  it("detects the changes a poll has to render", () => {
    const before = [file("a.txt"), { name: "src", path: "src", type: "dir" as const, children: [] }];
    expect(sameTree(before, [...before])).toBe(true);
    expect(sameTree(before, [file("a.txt", 11), before[1]!])).toBe(false);
    expect(sameTree(before, [file("a.txt"), file("b.txt"), before[1]!])).toBe(false);
    expect(sameTree(undefined, [])).toBe(false);
  });
});
