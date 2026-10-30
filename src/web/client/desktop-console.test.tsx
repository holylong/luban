import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { DesktopConsole } from "./desktop-console";
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

it("keeps the input row from shrinking when output grows", () => {
  const css = readFileSync(new URL("./desktop.css", import.meta.url), "utf8");
  expect(css).toMatch(/\.desktop-command-input\s*\{[^}]*flex: none/);
  expect(css).toMatch(/\.desktop-console-output\s*\{[^}]*min-height: 0;[^}]*overflow: auto/);
});
