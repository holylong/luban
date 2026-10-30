import type { ThemePalette } from "../../ui/theme";

export interface DesktopTheme {
  id: string;
  label: string;
  mode: "dark" | "light";
  palette: ThemePalette;
}
export interface ThemeCatalog {
  active: DesktopTheme;
  themes: Array<Omit<DesktopTheme, "palette"> & { description: string }>;
}

/** Semantic mapping shared by editor, terminal output, transcript and execution diffs. */
export function themeVariables({ palette: p }: DesktopTheme): Record<string, string> {
  return {
    "--bg": p.background, "--side": p.panel, "--panel": p.panel,
    "--panel-2": p.element, "--panel-3": p.selected, "--selected": p.selected,
    "--line": p.border, "--line-soft": p.element,
    "--fg": p.text, "--primary": p.primary, "--muted": p.muted, "--dim": p.dim,
    "--blue": p.accent, "--purple": p.purple, "--green": p.green,
    "--red": p.red, "--yellow": p.yellow, "--code": p.code,
    "--code-bg": p.codeBackground, "--add-bg": p.codeAddedBackground, "--del-bg": p.codeRemovedBackground,
    "--blue-soft": `color-mix(in srgb, ${p.accent} 14%, transparent)`,
    "--green-soft": `color-mix(in srgb, ${p.green} 12%, transparent)`,
    "--red-soft": `color-mix(in srgb, ${p.red} 12%, transparent)`,
    "--yellow-soft": `color-mix(in srgb, ${p.yellow} 12%, transparent)`,
  };
}

export function paintDesktopTheme(theme: DesktopTheme, root = document.documentElement): void {
  for (const [key, value] of Object.entries(themeVariables(theme))) root.style.setProperty(key, value);
  root.style.colorScheme = theme.mode;
  root.dataset.theme = theme.id;
}
