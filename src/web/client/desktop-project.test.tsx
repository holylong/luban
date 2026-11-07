import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ProjectSwitcher } from "./desktop";
import type { WorkbenchStore } from "./store";

function store(overrides: Partial<WorkbenchStore> = {}): WorkbenchStore {
  return {
    project: "luban",
    node: { version: "2.0.6", projects: { luban: "/home/me/luban", other: "/home/me/other" } },
    setProject: vi.fn(),
    ...overrides,
  } as unknown as WorkbenchStore;
}

afterEach(() => { vi.unstubAllGlobals(); });

describe("desktop project switcher", () => {
  it("replaces the pinned dropdown with a folder picker in desktop mode", () => {
    const openWorkspace = vi.fn().mockResolvedValue({ path: "/home/me/other" });
    vi.stubGlobal("window", { lubanDesktop: { openWorkspace } });

    const html = renderToStaticMarkup(<ProjectSwitcher store={store()} />);

    // The desktop backend serves exactly one root, so a project dropdown would
    // silently do nothing; the button is the only control that really switches.
    expect(html).not.toContain("<select");
    expect(html).toContain("打开文件夹");
    expect(html).toContain("/home/me/luban");
    expect(openWorkspace).not.toHaveBeenCalled();
  });

  it("keeps the project dropdown for the browser workbench", () => {
    vi.stubGlobal("window", {});

    const html = renderToStaticMarkup(<ProjectSwitcher store={store()} />);

    expect(html).toContain('<select id="desktop-project"');
    expect(html).not.toContain("打开文件夹");
    expect(html).not.toContain("disabled");
    expect(html).toContain("luban · /home/me/luban");
    expect(html).toContain("other · /home/me/other");
  });

  it("falls back to the dropdown when a desktop bridge has no picker", () => {
    vi.stubGlobal("window", { lubanDesktop: { listFiles: vi.fn() } });

    const html = renderToStaticMarkup(<ProjectSwitcher store={store()} />);

    expect(html).toContain('<select id="desktop-project"');
    expect(html).not.toContain("打开文件夹");
  });
});
