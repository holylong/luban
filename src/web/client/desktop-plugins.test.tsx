import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { DesktopStatusBar } from "./desktop";
import { PluginPanel, pluginBadge, pluginHeadline } from "./desktop-plugins";
import type { PluginPayload, PluginView } from "./desktop-plugins";

const fresh: PluginView = {
  id: "commit-chinese",
  name: "中文提交信息",
  version: "1.0.0",
  description: "提交信息写中文，先一句话再列要点。",
  tags: ["git", "中文"],
  skills: ["commit-chinese"],
};

const installed = {
  id: "commit-chinese", version: "1.0.0", installedAt: "2026-11-22T09:00:00.000Z",
  skills: ["commit-chinese"], files: { "skills/commit-chinese/SKILL.md": "a".repeat(64) },
};

const payload = (plugins: PluginView[], extra: Partial<PluginPayload> = {}): PluginPayload =>
  ({ registry: "https://example.test/plugins.json", plugins, installed: [], ...extra });

function render(pl: PluginPayload | undefined, extra: Partial<React.ComponentProps<typeof PluginPanel>> = {}): string {
  return renderToStaticMarkup(
    <PluginPanel payload={pl} query="" busy={false} onQuery={() => {}} onRefresh={() => {}}
      onInstall={() => {}} onUninstall={() => {}} onClose={() => {}} {...extra} />,
  );
}

describe("plugin panel copy", () => {
  it("lists a catalog entry with its tag, skill and install button", () => {
    const html = render(payload([fresh]));
    expect(html).toContain("中文提交信息");
    expect(html).toContain("1.0.0");
    expect(html).toContain("提交信息写中文");
    expect(html).toContain(">git<");
    expect(html).toContain("技能：commit-chinese");
    expect(html).toContain(">安装<");
    expect(html).toContain("list_skills");
    expect(html).not.toContain(">卸载<");
  });

  it("turns the buttons into reinstall + uninstall once the pack is on disk", () => {
    const html = render(payload([{ ...fresh, installed }], { installed: [installed] }));
    expect(html).toContain("已安装 1.0.0");
    expect(html).toContain(">重新安装<");
    expect(html).toContain(">卸载<");
    expect(pluginBadge({ ...fresh, installed })).toBe("已安装 1.0.0");
  });

  it("offers an update when the catalog version moved past the installed one", () => {
    const newer = { ...fresh, version: "2.0.0", installed, update: true };
    const html = render(payload([newer], { installed: [installed] }));
    expect(html).toContain("可更新 1.0.0 → 2.0.0");
    expect(html).toContain(">更新<");
    expect(pluginBadge(newer)).toBe("可更新 1.0.0 → 2.0.0");
  });

  it("marks only the row that is working", () => {
    const html = render(payload([fresh, { ...fresh, id: "sql-review", name: "SQL 审阅" }]), { busy: true, busyId: "sql-review" });
    expect(html).toContain("处理中…");
    // Both rows wait behind one install, and so does 刷新: 3 disabled buttons.
    expect(html.match(/disabled=""/gu)?.length).toBe(3);
  });

  it("keeps installed packs manageable when the catalog cannot be read", () => {
    const html = render({ registry: "https://example.test/plugins.json", plugins: [], installed: [installed],
      error: "插件目录读取失败（HTTP 503）" });
    expect(html).toContain("插件目录暂时读不到，已安装的仍可管理");
    expect(html).toContain("插件目录读取失败（HTTP 503）");
    expect(html).toContain("commit-chinese");
    expect(html).toContain(">卸载<");
  });

  it("says which search found nothing instead of showing an empty box", () => {
    const html = render(payload([], { installed: [] }), { query: "kubernetes" });
    expect(html).toContain("没有匹配「kubernetes」的插件");
    expect(pluginHeadline(payload([fresh]), "中文")).toBe("匹配「中文」的1 个插件 · 已安装 0 个");
  });

  it("reports the install result and any failure", () => {
    const html = render(payload([{ ...fresh, installed }], { installed: [installed] }),
      { notice: "已安装「中文提交信息」1 个技能：commit-chinese", error: "校验失败" });
    expect(html).toContain("已安装「中文提交信息」1 个技能");
    expect(html).toContain("校验失败");
  });

  it("puts the dock in the status bar next to 更新", () => {
    const store = {
      connected: true, project: "luban", node: { version: "2.9.5" }, file: { lines: 12, language: "TypeScript" },
    } as unknown as Parameters<typeof DesktopStatusBar>[0]["store"];
    const html = renderToStaticMarkup(<DesktopStatusBar store={store} />);
    expect(html).toContain("plugin-dock");
    expect(html).toContain(">插件<");
    expect(html).toContain("update-dock");
  });

  // The status bar docks sit at the left end of the bar, so a right-aligned
  // popover puts most of the list — and the search box — off-screen to the left.
  it("anchors the status-bar popovers to the dock's left edge", () => {
    const css = readFileSync(new URL("./desktop.css", import.meta.url), "utf8");
    const rule = (name: string): string => new RegExp(`\\.desktop-status \\.${name} \\{[^}]*\\}`).exec(css)?.[0] ?? "";
    for (const name of ["plugin-panel", "update-panel"]) {
      const block = rule(name);
      expect(block, `${name} needs an explicit status-bar rule`).not.toBe("");
      expect(block).toContain("left: 0");
      expect(block).toContain("right: auto");
      expect(block).toMatch(/width: min\(/);
    }
  });
});
