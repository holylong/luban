import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { expect, it, vi } from "vitest";
vi.mock("./desktop-editor", () => ({ DesktopEditor: () => <textarea defaultValue="unsaved buffer" /> }));
import { DesktopCodeArea } from "./desktop";
import type { WorkbenchStore } from "./store";

it("mounts the editor and diff in mutually exclusive tab panels, not stacked panes", () => {
  const store = { project: "p", session: { edits: [{ id: "e", name: "edit_file", preview: "+++ b/a.ts\n+new" }] } } as unknown as WorkbenchStore;
  const html = renderToStaticMarkup(<DesktopCodeArea store={store} timeline={[]} />);
  expect(html).toContain('aria-label="代码工作区"');
  expect(html).toContain('aria-selected="true">代码');
  expect(html).toContain('aria-label="修改对比" hidden=""');
  expect(html).toContain("unsaved buffer");
  expect(html).toContain("暂无当前修改");
  expect(html).not.toContain("+new");
  expect(html).not.toContain("<details");
});
