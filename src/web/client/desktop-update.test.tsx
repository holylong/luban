import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { DesktopStatusBar } from "./desktop";
import { UpdatePanel, updateHeadline, updateNotes } from "./desktop-update";
import type { UpdatePayload } from "./desktop-update";

const artifact = { version: "2.7.12", file: "luban-cli-2.7.12-mac-x64.zip", size: 52_428_800 };

function render(payload: UpdatePayload | undefined, extra: Partial<React.ComponentProps<typeof UpdatePanel>> = {}): string {
  return renderToStaticMarkup(
    <UpdatePanel payload={payload} busy={false} onCheck={() => {}} onInstall={() => {}} onSkip={() => {}}
      onClose={() => {}} onToggleCheck={() => {}} {...extra} />,
  );
}

const available: UpdatePayload = {
  settings: { check: true, skippedVersion: "" },
  check: { status: "available", current: "2.7.11", latest: "2.7.12", artifact, notes: "修好手机端的折叠问题。" },
};

describe("update panel copy", () => {
  it("names both versions and offers the three choices the user asked for", () => {
    const html = render(available);
    expect(html).toContain("新版本 2.7.12 可用（当前 2.7.11）");
    expect(html).toContain("升级到 2.7.12");
    expect(html).toContain("不再提醒");
    expect(html).toContain(">稍后</button>");
    expect(html).toContain("修好手机端的折叠问题。");
    expect(html).toContain("启动时检查更新");
  });

  it("offers the update again for a version the user chose to skip", () => {
    const html = render({ ...available, settings: { check: true, skippedVersion: "2.7.12" },
      check: { ...available.check, status: "skipped" } });
    expect(html).toContain("2.7.12 已设为不再提醒");
    expect(html).toContain("升级到 2.7.12");
  });

  it("stops offering buttons when there is nothing to install", () => {
    const html = render({ settings: { check: true, skippedVersion: "" }, check: { status: "current", current: "2.7.11" } });
    expect(html).toContain("已是最新版本 2.7.11");
    expect(html).not.toContain("升级到");
    expect(html).not.toContain("不再提醒");
    expect(html).toContain("立即检查");
  });

  it("shows the switch as off when checking is disabled", () => {
    const html = render({ settings: { check: false, skippedVersion: "" }, check: { status: "disabled", current: "2.7.11" } });
    expect(html).toContain("启动时检查更新已关闭");
    expect(html).not.toMatch(/<input[^>]*checked/u);
  });

  it("keeps the switch on by default when the settings block is older than this build", () => {
    const html = render({ settings: {} as UpdatePayload["settings"], check: { status: "current", current: "2.7.11" } });
    expect(html).toMatch(/<input[^>]*checked/u);
  });

  it("explains an unreachable release server instead of pretending to be current", () => {
    const html = render({ settings: { check: true, skippedVersion: "" },
      check: { status: "unreachable", current: "2.7.11", reason: "release server timed out" } });
    expect(html).toContain("暂时连不上升级服务器");
    expect(html).toContain("release server timed out");
  });

  it("warns that the desktop build restarts itself only when a bridge can install", () => {
    const browser = render(available);
    const desktop = render(available, { bridge: { checkUpdate: async () => ({ ok: true, status: "current" }) } });
    expect(browser).not.toContain("自动重启");
    expect(desktop).toContain("替换应用并自动重启");
  });

  it("disables every action while an install runs", () => {
    const html = render(available, { busy: true });
    expect(html).toContain("升级中…");
    expect(html).toContain("检查中…");
    expect(html.match(/disabled/gu)?.length).toBeGreaterThanOrEqual(4);
  });
});

describe("update helpers", () => {
  it("keeps release notes to one readable paragraph", () => {
    expect(updateNotes("  a\r\nb  ")).toBe("a\nb");
    expect(updateNotes("x".repeat(300))).toHaveLength(221);
    expect(updateNotes(undefined)).toBe("");
  });

  it("covers every status the release server can report", () => {
    expect(updateHeadline(undefined)).toBe("正在检查新版本…");
    expect(updateHeadline({ status: "no-build", current: "2.7.11", latest: "2.7.12" })).toContain("还没有这台电脑的安装包");
    expect(updateHeadline({ status: "available", current: "2.7.11", latest: "2.7.12" })).toBe("新版本 2.7.12 可用（当前 2.7.11）");
  });
});

describe("where the dock lives", () => {
  // The desktop shell is not the web sidebar: for a while the panel existed only
  // in `Sidebar`, so an Electron user had the menu item and nothing in the
  // window. This pins the dock to the status bar that spans all three columns.
  it("sits in the desktop status bar next to the connection light", () => {
    const store = {
      connected: true, project: "luban", node: { version: "2.7.12" }, file: { lines: 12, language: "TypeScript" },
    } as unknown as Parameters<typeof DesktopStatusBar>[0]["store"];
    const html = renderToStaticMarkup(<DesktopStatusBar store={store} />);
    expect(html).toContain("desktop-status");
    expect(html).toContain("update-dock");
    expect(html).toContain(">更新<");
    // The project and file cells keep their slot after the dock.
    expect(html).toContain("luban");
    expect(html).toContain("12 行 · TypeScript");
  });
});
