import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { DEFAULT_CONSOLE_HEIGHT, MIN_CONSOLE_HEIGHT } from "./desktop-layout";

// The desktop shell spent its space on chrome: 238px of sidebar before the first
// session, a 54px header for one file name and a 240px console for an empty
// panel. These are budgets, not pixel snapshots: each chrome row must stay under
// its ceiling so a later padding tweak cannot quietly grow it back.
const css = readFileSync(new URL("./desktop.css", import.meta.url), "utf8");

const body = (selector: string): string => {
  const pattern = new RegExp(`(?:^|\\n)${selector.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&")}\\s*\\{([^}]*)\\}`, "u");
  const found = pattern.exec(css);
  if (!found) throw new Error(`no rule for ${selector}`);
  return found[1]!;
};
const px = (selector: string, prop: string): number => {
  const found = new RegExp(`(?:^|[;{ ])${prop}:\\s*(\\d+)px`, "u").exec(body(selector));
  if (!found) throw new Error(`no ${prop} for ${selector}`);
  return Number(found[1]);
};
const paddingY = (selector: string): number => {
  const found = /padding:\s*([^;]+)/u.exec(body(selector));
  if (!found) throw new Error(`no padding for ${selector}`);
  const parts = found[1]!.trim().split(/\s+/u);
  return Number(parts[0]!.replace("px", ""));
};

describe("desktop density budget", () => {
  it("keeps the explorer chrome short enough to show sessions", () => {
    expect(px(".desktop-brand", "height")).toBeLessThanOrEqual(40);
    expect(px(".desktop-section", "height")).toBeLessThanOrEqual(24);
    expect(px(".desktop-file", "height")).toBeLessThanOrEqual(24);
    expect(px(".desktop-explorer-tabs button", "padding")).toBeLessThanOrEqual(6);
    expect(px(".desktop-project select", "padding")).toBeLessThanOrEqual(5);
    expect(paddingY(".desktop-list-row")).toBeLessThanOrEqual(5);
  });

  it("keeps the code header and tab strip down to one line each", () => {
    expect(px(".desktop-editor-head", "height")).toBeLessThanOrEqual(38);
    expect(px(".desktop-code-tabs button", "padding")).toBeLessThanOrEqual(6);
    expect(px(".desktop-document-tabs", "min-height")).toBeLessThanOrEqual(28);
    expect(px(".desktop-editor-info", "padding")).toBeLessThanOrEqual(3);
  });

  it("starts the console small and has no dead band when collapsed", () => {
    expect(DEFAULT_CONSOLE_HEIGHT).toBeLessThanOrEqual(190);
    expect(DEFAULT_CONSOLE_HEIGHT).toBeGreaterThan(MIN_CONSOLE_HEIGHT);
    expect(px(".desktop-console", "height")).toBe(DEFAULT_CONSOLE_HEIGHT);
    // Collapsed, the section is exactly its own tab strip.
    expect(px(".desktop-console.collapsed", "height")).toBe(px(".desktop-console-tabs", "height"));
    expect(px(".desktop-console-tabs", "height")).toBeLessThanOrEqual(30);
    expect(px(".desktop-command-input", "min-height")).toBeLessThanOrEqual(34);
  });

  it("leaves the agent column to the conversation", () => {
    expect(px(".desktop-agent .top", "min-height")).toBeLessThanOrEqual(40);
    expect(px(".desktop-agent .composer textarea", "min-height")).toBeLessThanOrEqual(40);
    expect(px(".desktop-agent .composer .send", "height")).toBeLessThanOrEqual(24);
    expect(px(".desktop-agent-tabs", "min-height")).toBeLessThanOrEqual(28);
    expect(px(".desktop-agent .msg", "margin-bottom")).toBeLessThanOrEqual(11);
  });
});
