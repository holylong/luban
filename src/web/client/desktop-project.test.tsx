import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import { folderLabel, PetToggle, ProjectSwitcher } from "./desktop";
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
    expect(html).toContain("/home/me/luban");
    expect(openWorkspace).not.toHaveBeenCalled();
  });

  it("names the open folder instead of repeating the instruction", () => {
    vi.stubGlobal("window", { lubanDesktop: { openWorkspace: vi.fn() } });
    const html = renderToStaticMarkup(<ProjectSwitcher store={store()} />);
    // The button doubles as the current-project label: 打开文件夹… is a prompt
    // that stops being useful once a folder is already open.
    expect(html).toContain(">luban<");
    expect(html).not.toContain("打开文件夹…");
    expect(html).toContain("当前项目 luban");
    expect(html).toContain("点击更换文件夹");
  });

  it("keeps the prompt when no folder is open yet", () => {
    vi.stubGlobal("window", { lubanDesktop: { openWorkspace: vi.fn() } });
    const html = renderToStaticMarkup(<ProjectSwitcher store={store({ project: "", node: { version: "2.0.6", projects: {} } })} />);
    expect(html).toContain("打开文件夹…");
    expect(html).not.toContain("desktop-open-workspace-name\">luban");
  });

  it("offers workspace creation when the native bridge supports it", () => {
    const createWorkspace = vi.fn();
    vi.stubGlobal("window", { lubanDesktop: { openWorkspace: vi.fn(), createWorkspace } });
    expect(renderToStaticMarkup(<ProjectSwitcher store={store()} />)).toContain("新建工作区…");
    expect(createWorkspace).not.toHaveBeenCalled();
  });

  it("offers a second window for another folder", () => {
    const openWorkspace = vi.fn();
    const openWorkspaceWindow = vi.fn();
    vi.stubGlobal("window", { lubanDesktop: { openWorkspace, openWorkspaceWindow } });

    const html = renderToStaticMarkup(<ProjectSwitcher store={store()} />);

    expect(html).toContain("新窗口");
    expect(openWorkspaceWindow).not.toHaveBeenCalled();
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

describe("folder name label", () => {
  it("takes the last segment of posix, windows and trailing-slash paths", () => {
    expect(folderLabel("/home/me/luban")).toBe("luban");
    expect(folderLabel("/home/me/luban/")).toBe("luban");
    expect(folderLabel("C:\\Users\\me\\cooler")).toBe("cooler");
    expect(folderLabel("/")).toBe("");
    expect(folderLabel(undefined)).toBe("");
  });
});

describe("desktop Creator overlay switch", () => {
  it("offers a hide control while the overlay is on screen", () => {
    vi.stubGlobal("window", { lubanDesktop: { togglePet: vi.fn().mockResolvedValue(false), petVisible: vi.fn() } });
    const html = renderToStaticMarkup(<PetToggle />);
    expect(html).toContain("Creator");
    expect(html).toContain('aria-pressed="false"');
    expect(html).toContain("显示 Creator 悬浮窗");
  });

  it("stays out of the browser workbench, which has no overlay", () => {
    vi.stubGlobal("window", {});
    expect(renderToStaticMarkup(<PetToggle />)).toBe("");
  });
});
