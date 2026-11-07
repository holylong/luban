import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { DesktopQuestions } from "./desktop";
import type { WorkbenchStore } from "./store";

const question = { id: "q1", job_id: "j1", created_at: 1, question: "请选择要生成的 Windows 安装包类型，这个问题需要完整显示而不是在狭窄侧栏截断", options: [
  { label: "EXE 安装器", description: "自动配置启动入口" },
  { label: "ZIP 便携包", description: "解压即可使用" },
] };

describe("desktop ask_user presentation", () => {
  it("uses a dedicated dialog with full choices, free text and task cancellation", () => {
    const html = renderToStaticMarkup(<DesktopQuestions store={{ questions: [question] } as WorkbenchStore} />);
    expect(html).toContain('<dialog class="desktop-question-dialog"');
    expect(html).toContain('aria-label="Agent 等待你的选择"');
    expect(html).toContain(question.question);
    for (const option of question.options) {
      expect(html).toContain(option.label);
      expect(html).toContain(option.description);
    }
    expect(html).toContain('aria-label="自定义回答"');
    expect(html).toContain("取消当前任务");
    expect(html).not.toContain('class="title"');
  });
  it("removes the dialog when there are no pending questions", () => {
    expect(renderToStaticMarkup(<DesktopQuestions store={{ questions: [] } as unknown as WorkbenchStore} />)).toBe("");
  });
  it("keeps prompts outside the shrinkable sidebar panel and wraps long choices", () => {
    const css = readFileSync(new URL("./desktop.css", import.meta.url), "utf8");
    expect(css).toMatch(/\.desktop-question-dialog \{[^}]*max-height: calc\(100vh - 48px\)[^}]*overflow: auto/);
    expect(css).toMatch(/\.question-title \{[^}]*white-space: normal/);
    expect(css).toMatch(/\.desktop-question-dialog \.action \{[^}]*white-space: normal/);
  });
});
