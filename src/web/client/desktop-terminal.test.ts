import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { terminalGrid, terminalWidth, DEFAULT_CELL } from "./desktop-terminal.js";

// xterm paints an exact cols×rows grid, so the pane has to be told its width
// from the outside: a grid that outgrows the code column grows the panel and
// paints the terminal over the conversation column on the right. A real
// Electron window reproduces this at 900px wide (panel 734px inside a 316px
// column); these cases pin the arithmetic that prevents it.
describe("terminal width", () => {
  it("never exceeds the panel that owns it", () => {
    expect(terminalWidth(734, 316)).toBe(316);
    expect(terminalWidth(316, 316)).toBe(316);
    expect(terminalWidth(316, 916)).toBe(316);
  });

  it("falls back to the holder when the owner has not been laid out yet", () => {
    // A hidden console measures 0: the holder is the only usable number.
    expect(terminalWidth(500, 0)).toBe(500);
    expect(terminalWidth(500, undefined)).toBe(500);
    expect(terminalWidth(0, 0)).toBe(0);
  });
});

describe("terminal grid inside a narrow column", () => {
  it("asks the pty for fewer columns instead of overflowing", () => {
    // 316px column, 6px padding each side, 7.6px cells: 40 columns fit.
    const width = terminalWidth(734, 316) - 12;
    expect(terminalGrid(width, 358, DEFAULT_CELL).cols).toBe(40);
    // The old, unclamped measurement asked for 95 columns in the same 316px
    // column, which is what painted the terminal over the conversation panel.
    expect(terminalGrid(734 - 12, 358, DEFAULT_CELL).cols).toBe(95);
  });

  it("still refuses a nonsense panel", () => {
    expect(terminalGrid(0, 0, DEFAULT_CELL)).toEqual({ cols: 20, rows: 5 });
  });
});

describe("desktop terminal CSS", () => {
  const css = readFileSync(new URL("./desktop.css", import.meta.url), "utf8");
  const body = (selector: string): string => {
    const pattern = new RegExp(`(?:^|\\n)${selector.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&")}\\s*\\{([^}]*)\\}`, "u");
    const found = pattern.exec(css);
    if (!found) throw new Error(`no rule for ${selector}`);
    return found[1]!;
  };

  it("keeps the clamp on every box between the console and xterm", () => {
    for (const selector of [".desktop-console", ".desktop-console-pane", ".desktop-terminal-panel", ".desktop-terminal"]) {
      expect(body(selector)).toMatch(/min-width:\s*0/u);
    }
    // The holder clips, so a stale grid can at worst disappear at its own edge
    // instead of painting over the conversation. The console itself stays
    // unclipped: its height splitter reaches 5px above the panel.
    expect(body(".desktop-terminal")).toMatch(/overflow:\s*hidden/u);
    expect(body(".desktop-console")).not.toMatch(/overflow:\s*hidden/u);
  });
});
