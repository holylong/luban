/**
 * Pane geometry for the desktop workbench. The three columns and the console
 * height are draggable, so their bounds and the persistence format live here as
 * pure functions: the view clamps, the browser remembers, and tests can check
 * that a stored layout can never collapse the code column.
 */
export interface DesktopLayout {
  /** File tree column, in pixels. */
  explorer: number;
  /** Agent column, in pixels. */
  agent: number;
  /** Command console height, in pixels. */
  console: number;
}

export const DESKTOP_LAYOUT_KEY = "luban.desktop.layout";
export const DEFAULT_EXPLORER_WIDTH = 250;
export const MIN_EXPLORER_WIDTH = 170;
export const MAX_EXPLORER_WIDTH = 520;
export const DEFAULT_AGENT_RATIO = 0.33;
export const MIN_AGENT_WIDTH = 300;
export const MIN_CONSOLE_HEIGHT = 160;
export const DEFAULT_CONSOLE_HEIGHT = 240;
/** The code column never shrinks below this, whatever is dragged. */
export const MIN_CODE_WIDTH = 320;

export function clampRange(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min;
  return Math.min(Math.max(value, min), Math.max(min, max));
}

export function defaultLayout(viewport: number): DesktopLayout {
  const width = Number.isFinite(viewport) && viewport > 0 ? viewport : 1024;
  return {
    explorer: DEFAULT_EXPLORER_WIDTH,
    agent: clampRange(Math.round(width * DEFAULT_AGENT_RATIO), MIN_AGENT_WIDTH, width - MIN_CODE_WIDTH - DEFAULT_EXPLORER_WIDTH - 10),
    console: DEFAULT_CONSOLE_HEIGHT,
  };
}

export function clampExplorer(value: number, viewport: number, agent: number): number {
  const max = Math.min(MAX_EXPLORER_WIDTH, viewport - agent - MIN_CODE_WIDTH - 10);
  return clampRange(value, MIN_EXPLORER_WIDTH, max);
}

export function clampAgent(value: number, viewport: number, explorer: number): number {
  return clampRange(value, MIN_AGENT_WIDTH, viewport - explorer - MIN_CODE_WIDTH - 10);
}

export function clampConsole(value: number, viewport: number): number {
  return clampRange(value, MIN_CONSOLE_HEIGHT, Math.round(viewport * 0.7));
}

/** Rescue a stored or freshly dragged layout against the current window size. */
export function fitLayout(layout: DesktopLayout, viewport: number): DesktopLayout {
  const base = defaultLayout(viewport);
  const agent = clampAgent(layout.agent, viewport, Math.min(layout.explorer, base.explorer));
  return {
    agent,
    explorer: clampExplorer(layout.explorer, viewport, agent),
    console: clampConsole(layout.console, viewport),
  };
}

export function parseLayout(raw: string | null | undefined, viewport: number): DesktopLayout {
  const base = defaultLayout(viewport);
  if (!raw) return base;
  let stored: Partial<Record<keyof DesktopLayout, unknown>>;
  try {
    stored = JSON.parse(raw) as Partial<Record<keyof DesktopLayout, unknown>>;
  } catch { return base; }
  if (!stored || typeof stored !== "object") return base;
  const pick = (value: unknown, fallback: number): number =>
    typeof value === "number" && Number.isFinite(value) ? value : fallback;
  return fitLayout({
    explorer: pick(stored.explorer, base.explorer),
    agent: pick(stored.agent, base.agent),
    console: pick(stored.console, base.console),
  }, viewport);
}

export function serializeLayout(layout: DesktopLayout): string {
  return JSON.stringify({ explorer: layout.explorer, agent: layout.agent, console: layout.console });
}

type LayoutStorage = Pick<Storage, "getItem" | "setItem">;

function storage(): LayoutStorage | undefined {
  try { return typeof window === "undefined" ? undefined : window.localStorage; }
  catch { return undefined; }
}

export function loadLayout(viewport: number, target: LayoutStorage | undefined = storage()): DesktopLayout {
  try { return parseLayout(target?.getItem(DESKTOP_LAYOUT_KEY), viewport); }
  catch { return defaultLayout(viewport); }
}

export function saveLayout(layout: DesktopLayout, target: LayoutStorage | undefined = storage()): void {
  try { target?.setItem(DESKTOP_LAYOUT_KEY, serializeLayout(layout)); }
  catch { /* A blocked storage must not break dragging. */ }
}
