import { describe, expect, it } from "vitest";
import { THEMES, activeThemeId, applyTheme, resolveTheme } from "../../ui/theme";
import { paintDesktopTheme, themeVariables } from "./desktop-theme";

describe("desktop CLI themes", () => {
  it("maps every CLI palette, including light themes and edit backgrounds", () => {
    for (const theme of THEMES) {
      const vars = themeVariables(theme);
      expect(vars["--bg"]).toBe(theme.palette.background);
      expect(vars["--fg"]).toBe(theme.palette.text);
      expect(vars["--add-bg"]).toBe(theme.palette.codeAddedBackground);
      expect(vars["--del-bg"]).toBe(theme.palette.codeRemovedBackground);
      expect(Object.values(vars).every(Boolean)).toBe(true);
    }
  });
  it("resolves aliases and config overrides without mutating terminal state", () => {
    applyTheme("nord");
    const resolved = resolveTheme("light", { accent: "#123456", invalid: "red" });
    expect(resolved.id).toBe("github-light");
    expect(resolved.palette.accent).toBe("#123456");
    expect(activeThemeId()).toBe("nord");
    expect(resolveTheme("unknown").id).toBe("midnight");
    applyTheme("midnight");
  });
  it("repaints variables and native controls for light then dark", () => {
    const vars = new Map<string, string>();
    const root = { style: { setProperty: (key: string, value: string) => vars.set(key, value), colorScheme: "" }, dataset: {} };
    for (const id of ["github-light", "dracula"]) {
      const theme = resolveTheme(id);
      paintDesktopTheme(theme, root as unknown as HTMLElement);
      expect(root.style.colorScheme).toBe(theme.mode);
      expect(root.dataset).toMatchObject({ theme: id });
      expect(vars.get("--bg")).toBe(theme.palette.background);
    }
  });
});
