import { describe, expect, it } from "vitest";
import {
  clampAgent, clampConsole, clampExplorer, DESKTOP_LAYOUT_KEY, defaultLayout, fitLayout,
  loadLayout, MIN_AGENT_WIDTH, MIN_CODE_WIDTH, MIN_CONSOLE_HEIGHT, MIN_EXPLORER_WIDTH,
  parseLayout, saveLayout, TERMINAL_CONSOLE_HEIGHT, terminalConsoleHeight,
} from "./desktop-layout";

describe("desktop pane layout", () => {
  it("keeps the default three columns inside a normal window", () => {
    const layout = defaultLayout(1440);
    expect(layout.explorer).toBe(250);
    expect(layout.agent).toBeGreaterThanOrEqual(MIN_AGENT_WIDTH);
    expect(layout.explorer + layout.agent + MIN_CODE_WIDTH).toBeLessThan(1440);
    expect(layout.console).toBe(240);
  });

  it("clamps every dragged edge, including hostile stored values", () => {
    expect(clampExplorer(10, 1440, 420)).toBe(MIN_EXPLORER_WIDTH);
    expect(clampExplorer(2000, 1440, 420)).toBeLessThanOrEqual(520);
    expect(clampAgent(10, 1440, 250)).toBe(MIN_AGENT_WIDTH);
    // A wide agent column may not squeeze the code column out of existence.
    expect(clampAgent(5000, 900, 250)).toBe(900 - 250 - MIN_CODE_WIDTH - 10);
    expect(clampConsole(0, 900)).toBe(MIN_CONSOLE_HEIGHT);
    expect(clampConsole(5000, 900)).toBe(630);
  });

  it("grows a short console when the terminal tab opens", () => {
    // 240px was only ~10 rows of terminal; opening it should give real space.
    expect(terminalConsoleHeight(240, 900)).toBeGreaterThanOrEqual(TERMINAL_CONSOLE_HEIGHT);
    // A console the user dragged taller is kept, and the window cap still applies.
    expect(terminalConsoleHeight(520, 900)).toBe(520);
    expect(terminalConsoleHeight(240, 600)).toBe(420);
  });

  it("rescues a layout stored for a much wider window", () => {
    const fitted = fitLayout({ explorer: 520, agent: 900, console: 400 }, 900);
    expect(fitted.agent).toBeLessThanOrEqual(900 - fitted.explorer - MIN_CODE_WIDTH);
    expect(fitted.explorer).toBeGreaterThanOrEqual(MIN_EXPLORER_WIDTH);
    expect(fitted.console).toBe(400);
  });

  it("falls back to defaults for missing or corrupt storage", () => {
    expect(parseLayout(null, 1200)).toEqual(defaultLayout(1200));
    expect(parseLayout("{not json", 1200)).toEqual(defaultLayout(1200));
    expect(parseLayout(JSON.stringify({ explorer: "wide", agent: null }), 1200)).toEqual(defaultLayout(1200));
  });

  it("round-trips through storage and survives a blocked one", () => {
    const values = new Map<string, string>();
    const storage = { getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => { values.set(key, value); } };
    saveLayout({ explorer: 300, agent: 480, console: 300 }, storage);
    expect(values.has(DESKTOP_LAYOUT_KEY)).toBe(true);
    expect(loadLayout(1440, storage)).toEqual({ explorer: 300, agent: 480, console: 300 });
    const blocked = { getItem: () => { throw new Error("denied"); }, setItem: () => { throw new Error("denied"); } };
    expect(loadLayout(1440, blocked)).toEqual(defaultLayout(1440));
    expect(() => saveLayout(defaultLayout(1440), blocked)).not.toThrow();
  });
});
