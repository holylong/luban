/**
 * Phone console appearance.
 *
 * The Android shell loads /m/ with `?theme=dark|light`, resolved from its own
 * picker, so the native window and the page can never disagree. When that value
 * is pinned the in-page picker is hidden. Opened from a plain browser the choice
 * is remembered on the device and defaults to following the system.
 */

export type ThemeMode = "dark" | "light" | "system";
export type ThemeName = "dark" | "light";

export interface Appearance {
  /** What the user picked, or what the shell pinned. */
  mode: ThemeMode;
  /** The palette actually rendered right now. */
  theme: ThemeName;
  /** True when the shell pinned the theme, so the page must not change it. */
  locked: boolean;
}

export const THEME_OPTIONS: Array<{ value: ThemeMode; label: string }> = [
  { value: "dark", label: "深色" },
  { value: "light", label: "浅色" },
  { value: "system", label: "跟随系统" },
];

export const THEME_COLORS: Record<ThemeName, string> = { dark: "#050607", light: "#f4f6f9" };

const STORAGE_KEY = "luban.mobile.theme";

function parseMode(value: unknown): ThemeMode | undefined {
  return value === "dark" || value === "light" || value === "system" ? value : undefined;
}

/** `?theme=light` — how the Android shell pins the palette for a load. */
export function themeFromQuery(search: string): ThemeMode | undefined {
  return parseMode(new URLSearchParams(search).get("theme"));
}

export function resolveTheme(mode: ThemeMode, systemDark: boolean): ThemeName {
  return mode === "system" ? (systemDark ? "dark" : "light") : mode;
}

export function appearanceOf(mode: ThemeMode, locked: boolean, systemDark: boolean): Appearance {
  return { mode, theme: resolveTheme(mode, systemDark), locked };
}

export function systemDark(): boolean {
  return typeof window.matchMedia === "function"
    ? window.matchMedia("(prefers-color-scheme: dark)").matches
    : true;
}

export function loadAppearance(search: string): Appearance {
  const pinned = themeFromQuery(search);
  if (pinned) return appearanceOf(pinned, true, systemDark());
  let stored: ThemeMode | undefined;
  try {
    stored = parseMode(window.localStorage.getItem(STORAGE_KEY));
  } catch {
    // Storage can be blocked in a private window; following the system is fine.
    stored = undefined;
  }
  return appearanceOf(stored ?? "system", false, systemDark());
}

export function saveAppearance(mode: ThemeMode): void {
  try {
    window.localStorage.setItem(STORAGE_KEY, mode);
  } catch {
    // Nothing to do: the choice simply does not survive a reload.
  }
}

/** Paint the palette and keep the browser/WebView chrome in step. */
export function applyAppearance(value: Appearance, root: HTMLElement = document.documentElement): void {
  root.dataset.lubanTheme = value.theme;
  const meta = document.querySelector('meta[name="theme-color"]');
  if (meta) meta.setAttribute("content", THEME_COLORS[value.theme]);
}
