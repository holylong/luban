import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { ConsoleOutput, DesktopConsole } from "./desktop-console";
import type { WorkbenchStore } from "./store";

const store = { notify: vi.fn() } as unknown as WorkbenchStore;
afterEach(() => vi.unstubAllGlobals());

it("explains why command execution is disabled without the desktop bridge", () => {
  vi.stubGlobal("window", {});
  const html = renderToStaticMarkup(<DesktopConsole store={store} />);
  expect(html).toContain("未检测到桌面连接");
  expect(html).toContain("浏览器预览不能执行本机命令");
  expect(html).toMatch(/<input[^>]*disabled=""/);
});

it("offers an enabled, labeled command input with the desktop bridge", () => {
  vi.stubGlobal("window", { lubanDesktop: { runCommand: vi.fn(), onCommandEvent: vi.fn() } });
  const html = renderToStaticMarkup(<DesktopConsole store={store} />);
  expect(html).toContain('for="desktop-command"');
  expect(html).toContain("按 Enter 运行");
  expect(html).not.toMatch(/<input[^>]*disabled/);
  expect(html).not.toContain("未检测到桌面连接");
});

it("renders Markdown tables, headings and code while preserving raw logs", () => {
  const text = "## 结论\n\n| 项目 | 结果 |\n| --- | --- |\n| 构建 | **通过** |\n\n```txt\n  raw log\n```";
  const html = renderToStaticMarkup(<ConsoleOutput text={text} />);
  expect(html).toContain("<table>");
  expect(html).toContain("<th>项目</th>");
  expect(html).toContain("<strong>通过</strong>");
  expect(html).toContain("<h2>结论</h2>");
  expect(html).toContain("  raw log");
  const raw = renderToStaticMarkup(<ConsoleOutput text={text} raw />);
  expect(raw).not.toContain("<table>");
  expect(raw).toContain("| 项目 | 结果 |");
});

it("escapes untrusted markup in rendered and raw output", () => {
  for (const raw of [false, true]) {
    const html = renderToStaticMarkup(<ConsoleOutput text={'<script>alert(1)</script>\n<img src=x onerror=alert(1)>'} raw={raw} />);
    expect(html).not.toContain("<script>");
    expect(html).not.toContain("<img");
    expect(html).toContain("&lt;script&gt;");
  }
});

it("keeps the input row from shrinking when output grows", () => {
  const css = readFileSync(new URL("./desktop.css", import.meta.url), "utf8");
  expect(css).toMatch(/\.desktop-command-input\s*\{[^}]*flex: none/);
  expect(css).toMatch(/\.desktop-console-output\s*\{[^}]*min-height: 0;[^}]*overflow: auto/);
});
