import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { expect, it } from "vitest";
import { CodexQuotaView, DesktopCodexQuota } from "./desktop-codex-quota";

it("hides quota for non-Codex providers", () => {
  expect(renderToStaticMarkup(<DesktopCodexQuota provider="openai" />)).toBe("");
  expect(renderToStaticMarkup(<DesktopCodexQuota provider="codex" />)).toContain("Codex 剩余额度");
});
it.each([0, 10, 20, 21, 75])("marks remaining %s correctly", remaining => {
  const html = renderToStaticMarkup(<CodexQuotaView quota={{ windows: [{ id: "primary", label: "主要额度", remaining, durationMins: 300, resetsAt: 1780000000 }] }} />);
  expect(html).toContain(`${remaining.toFixed(1)}%`);
  expect(html.includes("额度偏低")).toBe(remaining <= 20);
  expect(html).toContain("5小时");
  expect(html).toContain("重置");
});
it("distinguishes loading, unsupported accounts, failures and stale data", () => {
  expect(renderToStaticMarkup(<CodexQuotaView loading />)).toContain("正在查询");
  expect(renderToStaticMarkup(<CodexQuotaView quota={{ windows: [] }} />)).toContain("未返回额度窗口");
  const failed = renderToStaticMarkup(<CodexQuotaView quota={{ windows: [], error: "查询失败" }} />);
  expect(failed).toContain("查询失败");
  expect(failed).not.toContain("0.0%");
  expect(renderToStaticMarkup(<CodexQuotaView quota={{ windows: [], error: "失败", updatedAt: 1 }} />)).toContain("上次成功");
  const diagnosable = renderToStaticMarkup(<CodexQuotaView quota={{ windows: [], error: "无法查询 Codex 额度。",
    hint: "找不到 codex 命令：设置 LUBAN_CODEX_BIN 后重启 luban。", detail: "Cannot start Codex CLI: spawn codex ENOENT" }} />);
  expect(diagnosable).toContain("LUBAN_CODEX_BIN");
  expect(diagnosable).toContain("desktop-quota-detail");
  expect(diagnosable).toContain("ENOENT");
});

it("offers reset cards only when the account has some", () => {
  const none = renderToStaticMarkup(<CodexQuotaView quota={{ windows: [], credits: [], availableResetCredits: 0 }} onReset={() => {}} />);
  expect(none).not.toContain("使用重置卡");
  const many = renderToStaticMarkup(<CodexQuotaView onReset={() => {}} quota={{ windows: [], availableResetCredits: 2, credits: [
    { id: "card-1", title: "额度重置", expiresAt: 1_800_000_000 },
    { id: "card-2", title: "补充额度" },
  ] }} />);
  expect(many).toContain("可用重置卡 2 张");
  expect(many).toContain("使用重置卡");
  expect(many).toContain("选择重置卡");
  expect(many).toContain("card-1");
  expect(many).toContain("补充额度");
  // The first card is preselected, never an empty value.
  expect(many).toMatch(/value="card-1"[^>]*selected|selected[^>]*value="card-1"/u);
});

it("renders a single card without a picker and reports outcomes", () => {
  const single = renderToStaticMarkup(<CodexQuotaView onReset={() => {}} quota={{ windows: [], availableResetCredits: 1,
    credits: [{ id: "only", title: "额度重置" }] }} />);
  expect(single).toContain("可用重置卡 1 张");
  expect(single).not.toContain("选择重置卡");
  const done = renderToStaticMarkup(<CodexQuotaView quota={{ windows: [] }} resetMessage="已使用一张重置卡。" />);
  expect(done).toContain("已使用一张重置卡。");
  const failed = renderToStaticMarkup(<CodexQuotaView quota={{ windows: [] }} resetError="重置结果不确定" />);
  expect(failed).toContain("重置结果不确定");
  expect(failed).toContain('role="alert"');
  const busy = renderToStaticMarkup(<CodexQuotaView onReset={() => {}} resetting quota={{ windows: [], availableResetCredits: 1,
    credits: [{ id: "only", title: "额度重置" }] }} />);
  expect(busy).toContain("重置中…");
  expect(busy).toContain("disabled");
});
