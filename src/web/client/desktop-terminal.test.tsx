import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, expect, it, vi } from "vitest";
import { DesktopTerminal, terminalPalette } from "./desktop-terminal";

afterEach(() => vi.unstubAllGlobals());

it("maps the workbench CSS variables onto the terminal palette", () => {
  const palette = terminalPalette(name => ({ "--panel": " #101318 ", "--fg": "#edf0f5", "--blue": "#72a7ff" } as Record<string, string>)[name] ?? "");
  expect(palette).toEqual({ background: "#101318", foreground: "#edf0f5", cursor: "#72a7ff", selection: "#72a7ff22" });
});

it("explains that a real terminal needs the desktop bridge", () => {
  vi.stubGlobal("window", {});
  const html = renderToStaticMarkup(<DesktopTerminal />);
  expect(html).toContain("终端需要 luban Desktop 桌面连接");
  expect(html).toMatch(/<button[^>]*disabled=""[^>]*>重启终端/);
  expect(html).toContain('class="desktop-terminal"');
});

it("shows the startup state and an enabled restart once bridged", () => {
  vi.stubGlobal("window", { lubanDesktop: { startTerminal: vi.fn(), onCommandEvent: vi.fn(), writeTerminal: vi.fn(), stopTerminal: vi.fn() } });
  const html = renderToStaticMarkup(<DesktopTerminal />);
  expect(html).toContain("正在启动终端");
  expect(html).not.toMatch(/<button[^>]*disabled/);
});
