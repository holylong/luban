import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { DesktopSessionHistory } from "./desktop";
import type { SessionDetail } from "./types";

const session: SessionDetail = {
  id: "20261029114448-uh6fok",
  title: "使用 CMake 为项目打安装包",
  project: "HolyWatermarkRemover",
  workspace: "/tmp/project",
  model: "test/model",
  mode: "agent",
  updatedAt: "2026-10-30T00:55:15.822Z",
  createdAt: "2026-10-29T11:44:48.000Z",
  messages: [
    { role: "system", content: "harness prompt" },
    { role: "user", content: "帮我打一个安装包" },
    { role: "assistant", content: "已经生成 CPack 配置" },
  ],
  edits: [{ id: "call-1", name: "edit_file", preview: "+++ b/CMakeLists.txt\n+install(TARGETS app)" }],
};

describe("desktop agent session panel", () => {
  it("renders the saved transcript where the composer can continue it", () => {
    const html = renderToStaticMarkup(<DesktopSessionHistory session={session} />);
    expect(html).toContain("使用 CMake 为项目打安装包");
    expect(html).toContain("已经生成 CPack 配置");
    expect(html).toContain("编辑记录");
    // Two non-system messages are carried into the continuation.
    expect(html).toContain("已带上此前 2 条消息");
  });
});
