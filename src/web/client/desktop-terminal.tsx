import React, { useEffect, useRef, useState } from "react";
import "./desktop-bridge";
import "@xterm/xterm/css/xterm.css";

export interface TerminalPalette { background: string; foreground: string; cursor: string; selection: string }

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
 * A real pty terminal: the desktop bridge owns the shell, xterm.js renders the
 * bytes, so prompts, colours, `cd` and full-screen programs behave normally.
 * The shell size is fixed when it starts; restart applies a new size.
 */
export function DesktopTerminal(): React.ReactElement {
  const holder = useRef<HTMLDivElement>(null);
  const [status, setStatus] = useState("正在启动终端…");
  const [generation, setGeneration] = useState(0);
  const bridge = typeof window === "undefined" ? undefined : window.lubanDesktop;

  useEffect(() => {
    const element = holder.current;
    if (!bridge || !element) return;
    let disposed = false;
    let terminalId: string | undefined;
    let term: import("@xterm/xterm").Terminal | undefined;
    let unsubscribe: (() => void) | undefined;
    let dataListener: { dispose: () => void } | undefined;
    const fail = (cause: unknown): void => {
      if (!disposed) setStatus(`终端启动失败：${cause instanceof Error ? cause.message : String(cause)}`);
    };
    void import("@xterm/xterm").then(({ Terminal }) => {
      if (disposed) return;
      // The shell is sized once from the panel; xterm and the pty then agree.
      const fit = (size: number, cell: number, min: number, max: number): number =>
        Math.min(max, Math.max(min, Math.floor(size / cell)));
      const cols = fit(element.clientWidth - 16, 7.6, 40, 200);
      const rows = fit(element.clientHeight - 12, 17, 10, 60);
      const style = getComputedStyle(element);
      const palette = terminalPalette(name => style.getPropertyValue(name));
      term = new Terminal({
        cols, rows, cursorBlink: true, scrollback: 5000, fontSize: 12.5,
        fontFamily: 'ui-monospace, SFMono-Regular, "SF Mono", Menlo, Consolas, monospace',
        theme: {
          background: palette.background, foreground: palette.foreground,
          cursor: palette.cursor, selectionBackground: palette.selection,
        },
      });
      term.open(element);
      unsubscribe = bridge.onCommandEvent(event => {
        if (event.id !== terminalId) return;
        term?.write(event.kind === "exit" ? `\r\n[进程结束：${event.text}]\r\n` : event.text);
      });
      return bridge.startTerminal({ cols: term.cols, rows: term.rows }).then(started => {
        if (disposed) { void bridge.stopTerminal(started.id).catch(() => undefined); return; }
        terminalId = started.id;
        setStatus(started.pty
          ? `${started.shell} · ${started.cols}×${started.rows} PTY`
          : `${started.shell} · 无 PTY，颜色与全屏程序受限`);
        dataListener = term?.onData(data => { void bridge.writeTerminal({ id: started.id, data }).catch(() => undefined); });
        term?.focus();
      }).catch(fail);
    }).catch(fail);
    return () => {
      disposed = true;
      unsubscribe?.();
      dataListener?.dispose();
      if (terminalId) void bridge.stopTerminal(terminalId).catch(() => undefined);
      term?.dispose();
      element.replaceChildren();
    };
  }, [bridge, generation]);

  return <div className="desktop-terminal-panel">
    <div className="desktop-terminal-bar">
      <span className={`dot ${bridge ? "working" : ""}`} />
      <span className="desktop-terminal-status">{bridge ? status : "终端需要 luban Desktop 桌面连接"}</span>
      <span className="spacer" />
      <button onClick={() => setGeneration(value => value + 1)} disabled={!bridge}>重启终端</button>
    </div>
    <div className="desktop-terminal" ref={holder} />
  </div>;
}
