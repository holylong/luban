import { describe, expect, it } from "vitest";
import { appearanceOf, resolveTheme, themeFromQuery, THEME_OPTIONS } from "./mobile-theme";

describe("phone console appearance", () => {
  it("reads the palette the Android shell pins with ?theme=", () => {
    expect(themeFromQuery("?theme=light")).toBe("light");
    expect(themeFromQuery("?node=abc&theme=dark")).toBe("dark");
    expect(themeFromQuery("?theme=system")).toBe("system");
  });

  it("ignores unknown values so a bad link cannot break the console", () => {
    expect(themeFromQuery("?theme=neon")).toBeUndefined();
    expect(themeFromQuery("")).toBeUndefined();
  });

  it("resolves 跟随系统 from the device setting", () => {
    expect(resolveTheme("system", true)).toBe("dark");
    expect(resolveTheme("system", false)).toBe("light");
    expect(resolveTheme("light", true)).toBe("light");
    expect(resolveTheme("dark", false)).toBe("dark");
  });

  it("locks the in-page picker only when the shell pinned the theme", () => {
    expect(appearanceOf("light", true, false)).toEqual({ mode: "light", theme: "light", locked: true });
    expect(appearanceOf("system", false, false)).toEqual({ mode: "system", theme: "light", locked: false });
    expect(THEME_OPTIONS.map(option => option.value)).toEqual(["dark", "light", "system"]);
  });
});
