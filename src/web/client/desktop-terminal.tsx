import React, { useEffect, useRef, useState } from "react";
import "./desktop-bridge";
import "@xterm/xterm/css/xterm.css";

export interface TerminalPalette { background: string; foreground: string; cursor: string; selection: string }
export interface TerminalCell { width: number; height: number }

export const MIN_TERMINAL_COLS = 20;
export const MIN_TERMINAL_ROWS = 5;
export const MAX_TERMINAL_COLS = 400;
export const MAX_TERMINAL_ROWS = 200;
export const FONT_SIZES = [10, 11.5, 12.5, 14, 16, 18];
export const DEFAULT_FONT_SIZE = 12.5;
export const TERMINAL_FONT_KEY = "luban.terminal.fontSize";
/** Fallback cell size before xterm has painted once. */
export const DEFAULT_CELL: TerminalCell = { width: 7.6, height: 17 };

/** Maps the workbench CSS variables onto an xterm palette so the theme carries over. */
export function terminalPalette(read: (name: string) => string): TerminalPalette {
  const take = (name: string, fallback: string): string => {
    const value = read(name).trim();
    return value || fallback;
  };
  return {
    background: take("--panel", "#101318"),
    foreground: take("--fg", "#edf0f5"),
    cursor: take("--blue", "#72a7ff"),
    selection: take("--blue-soft", "#72a7ff22"),
  };
}

/**
 * How many character cells fit in the panel.
 *
 * The pty and xterm must agree on this: a terminal created once at a guessed
 * size only paints those rows, leaving the rest of the panel black and cutting
 * off long output. Bounds keep a nonsense measurement from asking the shell for
 * a 1×1 pty.
 */
export function terminalGrid(width: number, height: number, cell: TerminalCell): { cols: number; rows: number } {
  const cellWidth = Number.isFinite(cell.width) && cell.width >= 1 ? cell.width : DEFAULT_CELL.width;
  const cellHeight = Number.isFinite(cell.height) && cell.height >= 1 ? cell.height : DEFAULT_CELL.height;
  const usable = (value: number): number => (Number.isFinite(value) && value > 0 ? value : 0);
  const cols = Math.floor(usable(width) / cellWidth);
  const rows = Math.floor(usable(height) / cellHeight);
  return {
    cols: Math.min(MAX_TERMINAL_COLS, Math.max(MIN_TERMINAL_COLS, cols)),
    rows: Math.min(MAX_TERMINAL_ROWS, Math.max(MIN_TERMINAL_ROWS, rows)),
  };
}

/** Step through FONT_SIZES without running off either end. */
export function stepFontSize(current: number, direction: 1 | -1): number {
  const sizes = FONT_SIZES;
  if (direction > 0) return sizes.find(size => size > current) ?? sizes[sizes.length - 1]!;
  return [...sizes].reverse().find(size => size < current) ?? sizes[0]!;
}

export function readFontSize(storage: Pick<Storage, "getItem"> | undefined = typeof window === "undefined" ? undefined : window.localStorage): number {
  try {
    const stored = Number(storage?.getItem(TERMINAL_FONT_KEY));
    if (FONT_SIZES.includes(stored)) return stored;
  } catch { /* blocked storage keeps the default */ }
  return DEFAULT_FONT_SIZE;
}

export function saveFontSize(size: number, storage: Pick<Storage, "setItem"> | undefined = typeof window === "undefined" ? undefined : window.localStorage): void {
  try { storage?.setItem(TERMINAL_FONT_KEY, String(size)); }
  catch { /* A blocked storage must not break the terminal. */ }
}

/** xterm paints `.xterm-screen` at exactly cols×rows cells, so this is the real cell size. */
function measureCell(element: HTMLElement, term: import("@xterm/xterm").Terminal): TerminalCell {
  const rect = element.querySelector<HTMLElement>(".xterm-screen")?.getBoundingClientRect();
  if (rect && rect.width > 0 && rect.height > 0 && term.cols > 0 && term.rows > 0) {
    return { width: rect.width / term.cols, height: rect.height / term.rows };
  }
  return DEFAULT_CELL;
}

/**
 * A real pty terminal: the desktop bridge owns the shell, xterm.js renders the
 * bytes, so prompts, colours, `cd` and full-screen programs behave normally.
 * The grid follows the panel: dragging the console or resizing the window
 * re-fits xterm and tells the pty its new size.
 */
export function DesktopTerminal(): React.ReactElement {
  const holder = useRef<HTMLDivElement>(null);
  const terminal = useRef<import("@xterm/xterm").Terminal | undefined>(undefined);
  const cell = useRef<TerminalCell>({ ...DEFAULT_CELL });
  const liveId = useRef<string | undefined>(undefined);
  const [status, setStatus] = useState("正在启动终端…");
  const [generation, setGeneration] = useState(0);
  const [fontSize, setFontSize] = useState(() => readFontSize());
  const [size, setSize] = useState<{ cols: number; rows: number }>();
  const bridge = typeof window === "undefined" ? undefined : window.lubanDesktop;

  const fit = (): void => {
    const element = holder.current;
    const term = terminal.current;
    if (!element || !term || element.clientWidth < 60 || element.clientHeight < 60) return;
    const style = getComputedStyle(element);
    const padX = (Number.parseFloat(style.paddingLeft) || 0) + (Number.parseFloat(style.paddingRight) || 0);
    const padY = (Number.parseFloat(style.paddingTop) || 0) + (Number.parseFloat(style.paddingBottom) || 0);
    // Measure every time: the ratio stays valid after a font change and needs no
    // private xterm APIs, and it self-corrects an early paint-less measurement.
    cell.current = measureCell(element, term);
    const grid = terminalGrid(element.clientWidth - padX, element.clientHeight - padY, cell.current);
    if (grid.cols !== term.cols || grid.rows !== term.rows) term.resize(grid.cols, grid.rows);
  };

  useEffect(() => {
    const element = holder.current;
    if (!bridge || !element) return;
    let disposed = false;
    let unsubscribe: (() => void) | undefined;
    let dataListener: { dispose: () => void } | undefined;
    let resizedListener: { dispose: () => void } | undefined;
    let observer: ResizeObserver | undefined;
    let frame = 0;
    let term: import("@xterm/xterm").Terminal | undefined;
    const fail = (cause: unknown): void => {
      if (!disposed) setStatus(`终端启动失败：${cause instanceof Error ? cause.message : String(cause)}`);
    };
    void import("@xterm/xterm").then(({ Terminal }) => {
      if (disposed) return;
      const style = getComputedStyle(element);
      const palette = terminalPalette(name => style.getPropertyValue(name));
      const initial = terminalGrid(
        element.clientWidth > 60 ? element.clientWidth - 16 : 800,
        element.clientHeight > 60 ? element.clientHeight - 12 : 420,
        cell.current,
      );
      term = new Terminal({
        cols: initial.cols, rows: initial.rows, cursorBlink: true, scrollback: 5000, fontSize,
        fontFamily: 'ui-monospace, SFMono-Regular, "SF Mono", Menlo, Consolas, monospace',
        theme: {
          background: palette.background, foreground: palette.foreground,
          cursor: palette.cursor, selectionBackground: palette.selection,
        },
      });
      terminal.current = term;
      term.open(element);
      fit();
      setSize({ cols: term.cols, rows: term.rows });
      resizedListener = term.onResize(({ cols, rows }) => {
        setSize({ cols, rows });
        const id = liveId.current;
        if (id) void bridge.resizeTerminal?.({ id, cols, rows }).catch(() => undefined);
      });
      // The panel changes when the console is dragged, the window resizes or a
      // column splitter moves; without this the terminal keeps its birth size.
      observer = new ResizeObserver(() => {
        cancelAnimationFrame(frame);
        frame = requestAnimationFrame(() => { if (!disposed) fit(); });
      });
      observer.observe(element);
      unsubscribe = bridge.onCommandEvent(event => {
        if (event.id !== liveId.current) return;
        term?.write(event.kind === "exit" ? `\r\n[进程结束：${event.text}]\r\n` : event.text);
      });
      return bridge.startTerminal({ cols: term.cols, rows: term.rows }).then(started => {
        if (disposed) { void bridge.stopTerminal(started.id).catch(() => undefined); return; }
        liveId.current = started.id;
        setStatus(started.pty
          ? `${started.shell} · PTY`
          : `${started.shell} · 无 PTY，颜色与全屏程序受限`);
        dataListener = term?.onData(data => { void bridge.writeTerminal({ id: started.id, data }).catch(() => undefined); });
        // The first fit may have happened after the shell started.
        if (term && (started.cols !== term.cols || started.rows !== term.rows)) {
          void bridge.resizeTerminal?.({ id: started.id, cols: term.cols, rows: term.rows }).catch(() => undefined);
        }
        term?.focus();
      }).catch(fail);
    }).catch(fail);
    return () => {
      disposed = true;
      observer?.disconnect();
      cancelAnimationFrame(frame);
      unsubscribe?.();
      resizedListener?.dispose();
      dataListener?.dispose();
      const id = liveId.current;
      liveId.current = undefined;
      if (id) void bridge.stopTerminal(id).catch(() => undefined);
      term?.dispose();
      terminal.current = undefined;
      element.replaceChildren();
    };
    // `fontSize` is read when the terminal is created; later changes apply below.
  }, [bridge, generation]);

  useEffect(() => {
    const term = terminal.current;
    const element = holder.current;
    if (!term || !element) return;
    term.options.fontSize = fontSize;
    saveFontSize(fontSize);
    // New font metrics mean new cell sizes: re-fit once the render settles.
    const frame = requestAnimationFrame(() => { fit(); });
    return () => cancelAnimationFrame(frame);
  }, [fontSize]);

  return <div className="desktop-terminal-panel">
    <div className="desktop-terminal-bar">
      <span className={`dot ${bridge ? "working" : ""}`} />
      <span className="desktop-terminal-status">{bridge ? status : "终端需要 luban 桌面版连接"}</span>
      {size && <span className="desktop-terminal-size">{size.cols}×{size.rows}</span>}
      <span className="spacer" />
      <button aria-label="缩小终端字号" onClick={() => setFontSize(current => stepFontSize(current, -1))}
        disabled={!bridge || fontSize <= FONT_SIZES[0]!}>A−</button>
      <button aria-label="放大终端字号" onClick={() => setFontSize(current => stepFontSize(current, 1))}
        disabled={!bridge || fontSize >= FONT_SIZES[FONT_SIZES.length - 1]!}>A+</button>
      <button onClick={() => setGeneration(value => value + 1)} disabled={!bridge}>重启终端</button>
    </div>
    <div className="desktop-terminal" ref={holder} />
  </div>;
}
