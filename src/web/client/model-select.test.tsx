import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { Composer } from "./app";
import type { WorkbenchStore } from "./store";

const model = { id: "test/model", name: "Test Model", provider: "test", model: "model" };
function render(overrides: Partial<WorkbenchStore> = {}): string {
  const store = {
    connected: true, busy: false, events: [], queued: [], mode: "edits", project: "test",
    node: { model_id: model.id, models: [model], projects: {} }, ...overrides,
  } as unknown as WorkbenchStore;
  return renderToStaticMarkup(<Composer store={store} />);
}
function selector(html: string): string {
  return html.match(/<select aria-label="模型"[^>]*>/u)![0];
}

describe("model selector availability", () => {
  it("enables the configured list when the node is connected", () => {
    const html = render();
    expect(selector(html)).not.toContain("disabled");
    expect(html).toContain("Test Model · test");
  });
  it("explains initial loading instead of silently ignoring clicks", () => {
    const html = render({ connected: false, node: undefined });
    expect(selector(html)).toContain("disabled");
    expect(html).toContain('role="status">正在连接服务以加载模型列表');
  });
  it("shows the actual connection failure even when an old model is displayed", () => {
    const html = render({ connected: false, connectionError: "missing or invalid access token" });
    expect(html).toContain('role="status">模型列表连接失败：missing or invalid access token');
    expect(selector(html)).toContain("disabled");
  });
  it("explains an empty configuration", () => {
    const html = render({ node: { models: [], projects: {} } as WorkbenchStore["node"] });
    expect(html).toContain("未配置可用模型");
    expect(selector(html)).toContain("disabled");
  });
  it("explains the temporary submission lock", () => {
    const html = render({ busy: true });
    expect(html).toContain("正在提交任务，完成后可切换模型");
    expect(selector(html)).toContain("disabled");
  });
  it("does not lock model selection for a running task", () => {
    const html = render({ job: { status: "working" } as WorkbenchStore["job"] });
    expect(selector(html)).not.toContain("disabled");
  });
});
