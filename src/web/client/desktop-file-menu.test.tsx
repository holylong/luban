import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { fileMenuEntries, FileMenu, joinPath, menuPosition, nameProblem, parentPath } from "./desktop-file-menu";
import type { DesktopBridge } from "./desktop-bridge";

const bridge = {} as DesktopBridge;

describe("file menu contents", () => {
  it("offers reveal, copy and rename for a file", () => {
    expect(fileMenuEntries({ path: "src/app.ts", type: "file" }).map(entry => entry.action))
      .toEqual(["open", "reveal", "copy", "rename", "trash"]);
  });

  it("offers the create actions only for a folder or the root", () => {
    expect(fileMenuEntries({ path: "src", type: "dir" }).map(entry => entry.action))
      .toEqual(["open", "reveal", "copy", "new-file", "new-folder", "rename", "trash"]);
    expect(fileMenuEntries(undefined).map(entry => entry.action)).toEqual(["new-file", "new-folder"]);
  });

  it("marks every disk action as desktop-only", () => {
    const needsDesktop = fileMenuEntries({ path: "src", type: "dir" }).filter(entry => entry.needsDesktop);
    expect(needsDesktop.map(entry => entry.action)).toEqual(["reveal", "copy", "new-file", "new-folder", "rename", "trash"]);
  });
});

describe("file menu paths", () => {
  it("splits a workspace path into parent and name", () => {
    expect(parentPath("src/app.ts")).toBe("src");
    expect(parentPath("README.md")).toBe("");
    expect(parentPath("a/b/c.ts")).toBe("a/b");
    expect(joinPath("src", "app.ts")).toBe("src/app.ts");
    expect(joinPath("", "app.ts")).toBe("app.ts");
  });

  it("refuses the names the workspace service would reject", () => {
    expect(nameProblem("app.ts")).toBeUndefined();
    expect(nameProblem("  ")).toMatch(/不能为空/);
    expect(nameProblem("a/b.ts")).toMatch(/斜杠/);
    expect(nameProblem("..")).toMatch(/不可用/);
    expect(nameProblem("node_modules")).toMatch(/保留/);
  });
});

describe("file menu placement", () => {
  it("keeps the menu inside the window", () => {
    expect(menuPosition(40, 60, 5, { width: 1200, height: 800 })).toEqual({ left: 40, top: 60 });
    expect(menuPosition(1180, 790, 5, { width: 1200, height: 800 })).toEqual({ left: 1010, top: 640 });
    expect(menuPosition(-5, -5, 2, { width: 1200, height: 800 })).toEqual({ left: 4, top: 4 });
  });
});

describe("file menu rendering", () => {
  it("disables disk actions in a browser without the desktop bridge", () => {
    const html = renderToStaticMarkup(<FileMenu x={10} y={10} target={{ path: "src", type: "dir" }} onAction={vi.fn()} onClose={vi.fn()} />);
    expect(html).toContain('role="menu"');
    expect(html).toContain("在访达中显示");
    expect(html).toContain("disabled");
  });

  it("enables them when the bridge exists", () => {
    const html = renderToStaticMarkup(<FileMenu x={10} y={10} target={{ path: "src/app.ts", type: "file" }} bridge={bridge} onAction={vi.fn()} onClose={vi.fn()} />);
    expect(html).not.toContain("disabled");
    expect(html).toContain("移到废纸篓");
    expect(html).toContain("复制路径");
  });
});
