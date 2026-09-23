/**
 * Terminal color schemes.
 *
 * `theme` is one mutable object rather than a React context: every view imports
 * it directly, and re-assigning its fields repaints the whole workbench without
 * threading a palette through a dozen components. `applyTheme` swaps it, the
 * caller re-renders, and the next frame draws in the new colors.
 */

export interface ThemePalette {
  /** App canvas behind everything else. */
  background: string;
  /** Raised surface: dialogs, the completion popup, the header. */
  panel: string;
  /** Chips and inline blocks inside a panel. */
  element: string;
  /** Highlighted row of a list. */
  selected: string;
  /** Highest-emphasis text: headings, the prompt echo. */
  primary: string;
  /** Interactive color: borders, focus, mode badge. */
  accent: string;
  purple: string;
  green: string;
  yellow: string;
  red: string;
  /** Body text. */
  text: string;
  /** Secondary text: hints, metadata. */
  muted: string;
  /** Faintest text: separators, placeholders, timestamps. */
  dim: string;
  border: string;
  /** Inline code and file paths. */
  code: string;
  codeBackground: string;
  codeAddedBackground: string;
  codeRemovedBackground: string;
}

export interface ThemeDefinition {
  /** Stable id used by config, `--theme`, and `/theme`. */
  id: string;
  /** Human label for the picker. */
  label: string;
  /** Light palettes draw dark text on a bright canvas. */
  mode: "dark" | "light";
  /** One line for the picker row. */
  description: string;
  palette: ThemePalette;
}

/** The palette every consumer reads; replaced in place by `applyTheme`. */
export const theme: ThemePalette = {
  // Deep blue-gray surfaces keep long code and tool logs comfortable to scan.
  background: "#0b0f14",
  panel: "#101720",
  element: "#182230",
  selected: "#25364b",
  primary: "#f4f7fb",
  accent: "#72d6ff",
  purple: "#c4a7ff",
  green: "#7ee787",
  yellow: "#f2cc60",
  red: "#ff7b8a",
  text: "#d7e2f0",
  muted: "#91a0b5",
  dim: "#66778d",
  border: "#33475f",
  code: "#b8f36b",
  codeBackground: "#0f1a22",
  codeAddedBackground: "#11251e",
  codeRemovedBackground: "#2a171d",
};

export const THEMES: readonly ThemeDefinition[] = [
  {
    id: "midnight",
    label: "Midnight",
    mode: "dark",
    description: "深蓝夜色 · 默认，长日志最省眼",
    palette: { ...theme },
  },
  {
    id: "nord",
    label: "Nord",
    mode: "dark",
    description: "极地蓝 · 低饱和，偏冷静",
    palette: {
      background: "#2e3440", panel: "#343b49", element: "#434c5e", selected: "#4c566a",
      primary: "#eceff4", accent: "#88c0d0", purple: "#c79adb", green: "#a3be8c",
      yellow: "#ebcb8b", red: "#e8837f", text: "#d8dee9", muted: "#a9b4c4",
      dim: "#7c8798", border: "#4c566a", code: "#a3be8c", codeBackground: "#3b4252",
      codeAddedBackground: "#2b4033", codeRemovedBackground: "#452a31",
    },
  },
  {
    id: "dracula",
    label: "Dracula",
    mode: "dark",
    description: "紫夜 · 高饱和霓虹，对比强",
    palette: {
      background: "#21222c", panel: "#282a36", element: "#343746", selected: "#44475a",
      primary: "#f8f8f2", accent: "#8be9fd", purple: "#bd93f9", green: "#50fa7b",
      yellow: "#f1fa8c", red: "#ff5555", text: "#f8f8f2", muted: "#b6bcd0",
      dim: "#6272a4", border: "#44475a", code: "#f1fa8c", codeBackground: "#282a36",
      codeAddedBackground: "#1e3b2c", codeRemovedBackground: "#3d2027",
    },
  },
  {
    id: "gruvbox",
    label: "Gruvbox",
    mode: "dark",
    description: "暖棕复古 · 土黄底色，护眼",
    palette: {
      background: "#1d2021", panel: "#282828", element: "#32302f", selected: "#3c3836",
      primary: "#fbf1c7", accent: "#83a598", purple: "#d3869b", green: "#b8bb26",
      yellow: "#fabd2f", red: "#fb4934", text: "#ebdbb2", muted: "#bdae93",
      dim: "#928374", border: "#504945", code: "#b8bb26", codeBackground: "#282828",
      codeAddedBackground: "#2f3419", codeRemovedBackground: "#3c1f1f",
    },
  },
  {
    id: "tokyo-night",
    label: "Tokyo Night",
    mode: "dark",
    description: "東京夜色 · 冷蓝紫，偏现代",
    palette: {
      background: "#16161e", panel: "#1a1b26", element: "#24283b", selected: "#2f3549",
      primary: "#c0caf5", accent: "#7aa2f7", purple: "#bb9af7", green: "#9ece6a",
      yellow: "#e0af68", red: "#f7768e", text: "#a9b1d6", muted: "#8b93b8",
      dim: "#6b74a3", border: "#2f3549", code: "#9ece6a", codeBackground: "#1f2335",
      codeAddedBackground: "#1c2f26", codeRemovedBackground: "#361f28",
    },
  },
  {
    id: "catppuccin",
    label: "Catppuccin",
    mode: "dark",
    description: "摩卡奶油 · 低对比柔和粉紫",
    palette: {
      background: "#11111b", panel: "#1e1e2e", element: "#313244", selected: "#45475a",
      primary: "#cdd6f4", accent: "#89b4fa", purple: "#cba6f7", green: "#a6e3a1",
      yellow: "#f9e2af", red: "#f38ba8", text: "#cdd6f4", muted: "#a6adc8",
      dim: "#7f849c", border: "#45475a", code: "#a6e3a1", codeBackground: "#181825",
      codeAddedBackground: "#193a29", codeRemovedBackground: "#3d1c28",
    },
  },
  {
    id: "amber",
    label: "Amber CRT",
    mode: "dark",
    description: "琥珀单色 · 复古终端，全暖色",
    palette: {
      background: "#100b02", panel: "#1a1206", element: "#241a09", selected: "#3a2a10",
      primary: "#ffe6bb", accent: "#ffb000", purple: "#ffd08a", green: "#ffd27f",
      yellow: "#ffc24d", red: "#ff8f4d", text: "#f0c88a", muted: "#c8a066",
      dim: "#8a6b3a", border: "#4a3410", code: "#ffd27f", codeBackground: "#1a1206",
      codeAddedBackground: "#2a3310", codeRemovedBackground: "#40220d",
    },
  },
  {
    id: "contrast",
    label: "Contrast",
    mode: "dark",
    description: "纯黑高对比 · 低视力/强光下清晰",
    palette: {
      background: "#000000", panel: "#0a0a0a", element: "#161616", selected: "#2b2b2b",
      primary: "#ffffff", accent: "#4da3ff", purple: "#c9a0ff", green: "#4ade80",
      yellow: "#ffd83d", red: "#ff6b6b", text: "#f5f5f5", muted: "#d0d0d0",
      dim: "#a0a0a0", border: "#5a5a5a", code: "#4ade80", codeBackground: "#101010",
      codeAddedBackground: "#0d2a17", codeRemovedBackground: "#33111a",
    },
  },
  {
    id: "solarized-dark",
    label: "Solarized Dark",
    mode: "dark",
    description: "经典 Solarized · 青蓝低对比",
    palette: {
      background: "#002b36", panel: "#073642", element: "#0f4655", selected: "#14505f",
      primary: "#fdf6e3", accent: "#2aa198", purple: "#8f95e8", green: "#859900",
      yellow: "#b58900", red: "#ef655c", text: "#93a1a1", muted: "#8b9d9c",
      dim: "#657b83", border: "#14505f", code: "#2aa198", codeBackground: "#073642",
      codeAddedBackground: "#0b3a2b", codeRemovedBackground: "#3f2018",
    },
  },
  {
    id: "solarized-light",
    label: "Solarized Light",
    mode: "light",
    description: "米色纸面 · 白天/投屏不刺眼",
    palette: {
      background: "#fdf6e3", panel: "#eee8d5", element: "#e6e0cb", selected: "#d6cfb8",
      primary: "#073642", accent: "#1570a6", purple: "#5a5fb0", green: "#5f7500",
      yellow: "#8a6a00", red: "#c8302c", text: "#586e75", muted: "#657b83",
      dim: "#7f8c8d", border: "#d3ccb5", code: "#1570a6", codeBackground: "#eee8d5",
      codeAddedBackground: "#dcead4", codeRemovedBackground: "#f7dbd8",
    },
  },
  {
    id: "github-light",
    label: "GitHub Light",
    mode: "light",
    description: "纯白 GitHub 风 · 亮环境阅读",
    palette: {
      background: "#ffffff", panel: "#f6f8fa", element: "#eaeef2", selected: "#dfe5eb",
      primary: "#1f2328", accent: "#0969da", purple: "#8250df", green: "#1a7f37",
      yellow: "#9a6700", red: "#cf222e", text: "#32383f", muted: "#57606a",
      dim: "#8c959f", border: "#d0d7de", code: "#0969da", codeBackground: "#f6f8fa",
      codeAddedBackground: "#e6ffec", codeRemovedBackground: "#ffeef0",
    },
  },
];

/** Accepted spellings that are not theme ids, so muscle memory still works. */
const ALIASES: Record<string, string> = {
  default: "midnight",
  dark: "midnight",
  "blue-gray": "midnight",
  light: "github-light",
  "high-contrast": "contrast",
  "tokyo": "tokyo-night",
  "catppuccin-mocha": "catppuccin",
  "crt": "amber",
  "solarized": "solarized-dark",
};

/** Color keys a config file may override; anything else is ignored. */
export const THEME_KEYS = Object.keys(theme) as Array<keyof ThemePalette>;

/** Resolves an id or alias to a real theme id, or null when unknown. */
export function resolveThemeId(value: string): string | null {
  const needle = value.trim().toLowerCase();
  if (!needle) return null;
  const id = ALIASES[needle] ?? needle;
  return THEMES.some((item) => item.id === id) ? id : null;
}

export function findTheme(value: string): ThemeDefinition | undefined {
  const id = resolveThemeId(value);
  return id ? THEMES.find((item) => item.id === id) : undefined;
}

/** Ids in listing order; the first one is the default. */
export function themeIds(): string[] {
  return THEMES.map((item) => item.id);
}

let activeId = THEMES[0]!.id;
let activeColors: Partial<ThemePalette> | undefined;

/**
 * Repaints the workbench in `value`, merged with per-key `colors` overrides
 * from the config file. An unknown id falls back to the default palette rather
 * than leaving the UI in an undefined color state, and returns what was applied
 * so a caller can tell the user what actually happened.
 */
export function applyTheme(value: string, colors?: Record<string, string>): ThemeDefinition {
  const definition = findTheme(value) ?? THEMES[0]!;
  const overrides = validColors(colors);
  activeId = definition.id;
  activeColors = overrides;
  Object.assign(theme, definition.palette, overrides ?? {});
  return { ...definition, palette: { ...theme } };
}

/** Id of the palette currently painted. */
export function activeThemeId(): string {
  return activeId;
}

/** The active definition including any config overrides. */
export function activeTheme(): ThemeDefinition {
  const definition = THEMES.find((item) => item.id === activeId) ?? THEMES[0]!;
  return { ...definition, palette: { ...theme } };
}

/** True when the config file overrides individual colors, for status lines. */
export function themeHasOverrides(): boolean {
  return Boolean(activeColors && Object.keys(activeColors).length);
}

function validColors(colors?: Record<string, string>): Partial<ThemePalette> | undefined {
  if (!colors) return undefined;
  const entries = Object.entries(colors).flatMap(([key, value]) => {
    if (!THEME_KEYS.includes(key as keyof ThemePalette)) return [];
    // A color is a single token: `#rgb`, `#rrggbb`, or a named color. Rejecting
    // anything with whitespace keeps a stray config line from breaking layout.
    if (typeof value !== "string" || !value.trim() || /\s/u.test(value.trim())) return [];
    return [[key, value.trim()] as [keyof ThemePalette, string]];
  });
  return entries.length ? Object.fromEntries(entries) as Partial<ThemePalette> : undefined;
}
