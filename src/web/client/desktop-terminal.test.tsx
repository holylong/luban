import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  DEFAULT_CELL, DEFAULT_FONT_SIZE, DesktopTerminal, FONT_SIZES, MAX_TERMINAL_COLS, MAX_TERMINAL_ROWS,
  MIN_TERMINAL_COLS, MIN_TERMINAL_ROWS, readFontSize, saveFontSize, stepFontSize, TERMINAL_FONT_KEY,
  terminalGrid, terminalPalette,
} from "./desktop-terminal";

afterEach(() => vi.unstubAllGlobals());

it("maps the workbench CSS variables onto the terminal palette", () => {
  const palette = terminalPalette(name => ({ "--panel": " #101318 ", "--fg": "#edf0f5", "--blue": "#72a7ff" } as Record<string, string>)[name] ?? "");
  expect(palette).toEqual({ background: "#101318", foreground: "#edf0f5", cursor: "#72a7ff", selection: "#72a7ff22" });
});

it("explains that a real terminal needs the desktop bridge", () => {
  vi.stubGlobal("window", {});
  const html = renderToStaticMarkup(<DesktopTerminal />);
  expect(html).toContain("终端需要 luban 桌面版连接");
  expect(html).toMatch(/<button[^>]*disabled=""[^>]*>重启终端/);
  expect(html).toContain('class="desktop-terminal"');
});

it("shows the startup state and an enabled restart once bridged", () => {
  vi.stubGlobal("window", { lubanDesktop: { startTerminal: vi.fn(), onCommandEvent: vi.fn(), writeTerminal: vi.fn(), stopTerminal: vi.fn() } });
  const html = renderToStaticMarkup(<DesktopTerminal />);
  expect(html).toContain("正在启动终端");
  expect(html).not.toMatch(/<button[^>]*disabled/);
});

describe("terminal grid", () => {
  it("fills the panel with whole cells instead of one fixed band", () => {
    // 800×420 of usable space with an 8×17.5 cell: 100 columns, 24 rows.
    expect(terminalGrid(800, 420, { width: 8, height: 17.5 })).toEqual({ cols: 100, rows: 24 });
    // A taller panel must ask the pty for more rows, not keep its birth size.
    expect(terminalGrid(800, 840, { width: 8, height: 17.5 }).rows).toBe(48);
    expect(terminalGrid(1600, 420, { width: 8, height: 17.5 }).cols).toBe(200);
  });

  it("never sends a nonsense size to the pty", () => {
    expect(terminalGrid(0, 0, DEFAULT_CELL)).toEqual({ cols: MIN_TERMINAL_COLS, rows: MIN_TERMINAL_ROWS });
    // Unmeasurable space collapses to the minimum grid, never to NaN.
    expect(terminalGrid(Number.NaN, Number.POSITIVE_INFINITY, DEFAULT_CELL))
      .toEqual({ cols: MIN_TERMINAL_COLS, rows: MIN_TERMINAL_ROWS });
    expect(terminalGrid(1e9, 1e9, { width: 1, height: 1 })).toEqual({ cols: MAX_TERMINAL_COLS, rows: MAX_TERMINAL_ROWS });
    // A broken measurement falls back to the default cell, not a divide by zero.
    expect(terminalGrid(800, 420, { width: 0, height: 0 })).toEqual(terminalGrid(800, 420, DEFAULT_CELL));
  });
});

describe("terminal font size", () => {
  it("steps through the presets and stops at both ends", () => {
    expect(stepFontSize(DEFAULT_FONT_SIZE, 1)).toBe(14);
    expect(stepFontSize(DEFAULT_FONT_SIZE, -1)).toBe(11.5);
    expect(stepFontSize(FONT_SIZES[FONT_SIZES.length - 1]!, 1)).toBe(FONT_SIZES[FONT_SIZES.length - 1]);
    expect(stepFontSize(FONT_SIZES[0]!, -1)).toBe(FONT_SIZES[0]);
  });

  it("remembers the size and ignores junk", () => {
    const written: Array<[string, string]> = [];
    saveFontSize(16, { setItem: (key: string, value: string) => { written.push([key, value]); } });
    expect(written).toEqual([[TERMINAL_FONT_KEY, "16"]]);
    expect(readFontSize({ getItem: () => "16" })).toBe(16);
    expect(readFontSize({ getItem: () => "99" })).toBe(DEFAULT_FONT_SIZE);
    expect(readFontSize({ getItem: () => "wide" })).toBe(DEFAULT_FONT_SIZE);
    expect(readFontSize(undefined)).toBe(DEFAULT_FONT_SIZE);
  });
});
