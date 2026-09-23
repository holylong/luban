import { afterEach, describe, expect, it } from "vitest";
import {
  activeTheme, activeThemeId, applyTheme, findTheme, resolveThemeId,
  THEMES, THEME_KEYS, theme, themeIds,
} from "./theme.js";

/** WCAG relative luminance; used to keep every palette readable by construction. */
function luminance(color: string): number {
  const channels = [1, 3, 5].map((index) => parseInt(color.slice(index, index + 2), 16) / 255);
  const linear = channels.map((channel) => channel <= 0.03928 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4);
  return 0.2126 * linear[0]! + 0.7152 * linear[1]! + 0.0722 * linear[2]!;
}

/** Contrast ratio between two palettes entries, 1 (identical) to 21 (black/white). */
function contrast(first: string, second: string): number {
  const [high, low] = [luminance(first), luminance(second)].sort((a, b) => b - a);
  return (high! + 0.05) / (low! + 0.05);
}

afterEach(() => {
  // The palette is module state: a test that swaps it must not tint the next one.
  applyTheme("midnight");
});

describe("theme catalog", () => {
  it("offers unique ids and both dark and light schemes", () => {
    const ids = themeIds();
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids[0]).toBe("midnight");
    expect(THEMES.some((item) => item.mode === "light")).toBe(true);
    expect(THEMES.some((item) => item.mode === "dark")).toBe(true);
    expect(THEMES.length).toBeGreaterThanOrEqual(8);
    for (const item of THEMES) expect(item.description.trim()).not.toBe("");
  });

  it("defines every palette key as a hex color", () => {
    for (const item of THEMES) {
      expect(Object.keys(item.palette).sort()).toEqual([...THEME_KEYS].sort());
      for (const key of THEME_KEYS) expect(item.palette[key]).toMatch(/^#[0-9a-f]{6}$/iu);
    }
  });

  /**
   * A color scheme is only usable if it stays readable: the accent colors carry
   * tool status, `dim` is deliberately faint but must still be visible, and the
   * diff backgrounds are what added/removed lines are drawn on.
   */
  it("keeps every palette readable against the surfaces it is drawn on", () => {
    for (const { id, palette } of THEMES) {
      const background = palette.background;
      expect(contrast(palette.primary, background), `${id} primary`).toBeGreaterThanOrEqual(8);
      expect(contrast(palette.text, background), `${id} text`).toBeGreaterThanOrEqual(4.5);
      expect(contrast(palette.muted, background), `${id} muted`).toBeGreaterThanOrEqual(4);
      expect(contrast(palette.dim, background), `${id} dim`).toBeGreaterThanOrEqual(2.5);
      for (const key of ["accent", "green", "yellow", "red", "purple", "code"] as const) {
        expect(contrast(palette[key], background), `${id} ${key}`).toBeGreaterThanOrEqual(4.5);
      }
      // The focused cell paints the background color on top of the accent.
      expect(contrast(palette.background, palette.accent), `${id} caret`).toBeGreaterThanOrEqual(4.5);
      // Text sits on the panel, the element chips, and both diff backgrounds.
      expect(contrast(palette.muted, palette.panel), `${id} muted on panel`).toBeGreaterThanOrEqual(3);
      expect(contrast(palette.muted, palette.element), `${id} muted on element`).toBeGreaterThanOrEqual(3);
      expect(contrast(palette.text, palette.codeBackground), `${id} text on code`).toBeGreaterThanOrEqual(4);
      expect(contrast(palette.text, palette.codeAddedBackground), `${id} text on added`).toBeGreaterThanOrEqual(4);
      expect(contrast(palette.text, palette.codeRemovedBackground), `${id} text on removed`).toBeGreaterThanOrEqual(4);
    }
  });

  it("resolves ids, aliases, and case, and rejects unknown names", () => {
    expect(resolveThemeId("nord")).toBe("nord");
    expect(resolveThemeId("  Tokyo-Night ")).toBe("tokyo-night");
    expect(resolveThemeId("default")).toBe("midnight");
    expect(resolveThemeId("dark")).toBe("midnight");
    expect(resolveThemeId("light")).toBe("github-light");
    expect(resolveThemeId("solarized")).toBe("solarized-dark");
    expect(resolveThemeId("solarized-light")).toBe("solarized-light");
    expect(resolveThemeId("neon-disco")).toBeNull();
    expect(resolveThemeId("")).toBeNull();
    expect(findTheme("neon-disco")).toBeUndefined();
  });

  it("repaints the shared palette in place", () => {
    // Every view module imported this object once at load time, so a swap has to
    // rewrite its fields rather than replace it.
    const imported = theme;
    const applied = applyTheme("nord");
    expect(applied.id).toBe("nord");
    expect(activeThemeId()).toBe("nord");
    expect(theme.background).toBe("#2e3440");
    expect(imported.background).toBe("#2e3440");
    expect(activeTheme().label).toBe("Nord");
    applyTheme("dracula");
    expect(theme.background).toBe("#21222c");
    expect(activeThemeId()).toBe("dracula");
  });

  it("falls back to the default palette for an unknown theme", () => {
    applyTheme("dracula");
    const applied = applyTheme("neon-disco");
    expect(applied.id).toBe("midnight");
    expect(theme.background).toBe("#0b0f14");
  });

  it("merges per-key config overrides and ignores junk", () => {
    const applied = applyTheme("nord", { accent: "#ff00ff", nope: "#000000", empty: "  " });
    expect(theme.accent).toBe("#ff00ff");
    expect(applied.palette.accent).toBe("#ff00ff");
    // Untouched keys keep the base theme, so an override never blanks the UI.
    expect(theme.background).toBe("#2e3440");
    expect(theme).not.toHaveProperty("nope");
    // Overrides are per-apply, not sticky: the next palette starts from its own
    // definition so switching away cannot leave a half-overridden scheme.
    applyTheme("gruvbox");
    expect(theme.accent).toBe("#83a598");
    expect(theme.background).toBe("#1d2021");
  });
});
