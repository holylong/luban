import React, { useEffect, useRef, useState } from "react";
import type { WorkbenchStore } from "./store";
import { desktopErrorText } from "./desktop-bridge";
import { Markdown } from "./markdown";
import { DesktopTerminal } from "./desktop-terminal";

export function ConsoleOutput({ text, raw = false }: { text: string; raw?: boolean }): React.ReactElement {
  return raw ? <pre>{text}</pre> : <div className="desktop-console-markdown"><Markdown text={text} /></div>;
}

interface Command { id: string; command: string; output: string; exit?: string }
export function DesktopConsole({ store }: { store: WorkbenchStore }): React.ReactElement {
  const [visible, setVisible] = useState(true);
  const [tab, setTab] = useState<"console" | "task" | "terminal">("console");
  const [terminalReady, setTerminalReady] = useState(false);
  const [command, setCommand] = useState("");
  const [raw, setRaw] = useState(false);
  const [commands, setCommands] = useState<Command[]>([]);
  const [starting, setStarting] = useState(false);
  const [history, setHistory] = useState<string[]>([]);
  const [historyIndex, setHistoryIndex] = useState(-1);
  const input = useRef<HTMLInputElement>(null);
  const output = useRef<HTMLDivElement>(null);
  const pendingEvents = useRef<Map<string, { text: string; exit?: string }>>(new Map());
  const bridge = typeof window === "undefined" ? undefined : window.lubanDesktop;
  useEffect(() => {
    if (visible && tab === "console" && bridge) input.current?.focus();
  }, [visible, tab, bridge]);
  useEffect(() => bridge?.onCommandEvent(event => {
    const prior = pendingEvents.current.get(event.id) ?? { text: "" };
    if (event.kind === "output") prior.text = (prior.text + event.text).slice(-200000);
    else prior.exit = event.text;
    pendingEvents.current.set(event.id, prior);
    if (pendingEvents.current.size > 50) pendingEvents.current.delete(pendingEvents.current.keys().next().value!);
    setCommands(current => current.map(item => item.id === event.id ? { ...item, output: prior.text, exit: prior.exit } : item));
  }), [bridge]);
  useEffect(() => {
    const key = (event: KeyboardEvent): void => {
      if ((event.ctrlKey || event.metaKey) && event.key === "`") { event.preventDefault(); setVisible(current => !current); }
    };
    window.addEventListener("keydown", key);
    return () => window.removeEventListener("keydown", key);
  }, []);
  useEffect(() => { if (output.current) output.current.scrollTop = output.current.scrollHeight; }, [commands, raw]);
  const run = async (): Promise<void> => {
    if (!bridge || !command.trim() || starting) return;
    const text = command;
    setStarting(true);
    try {
      const { id } = await bridge.runCommand(text);
      const pending = pendingEvents.current.get(id);
      setCommands(current => [...current.slice(-29), { id, command: text, output: pending?.text ?? "", exit: pending?.exit }]);
      setHistory(current => [text, ...current].slice(0, 100)); setHistoryIndex(-1); setCommand("");
    } catch (cause) { store.notify(desktopErrorText(cause), true); }
    finally { setStarting(false); input.current?.focus(); }
  };
  return <section className={`desktop-console${tab === "terminal" ? " terminal" : ""}${visible ? "" : " collapsed"}`}>
    <div className="desktop-console-tabs"><button className={tab === "console" ? "active" : ""} onClick={() => { setTab("console"); setVisible(true); input.current?.focus(); }}>控制台</button><button className={tab === "terminal" ? "active" : ""} onClick={() => { setTerminalReady(true); setTab("terminal"); setVisible(true); }}>终端</button><button className={tab === "task" ? "active" : ""} onClick={() => { setTab("task"); setVisible(true); }}>任务信息</button><span className="spacer" /><button onClick={() => { setCommands(current => current.filter(item => !item.exit)); }}>清除已结束</button><button aria-label={visible ? "折叠控制台" : "展开控制台"} onClick={() => setVisible(current => !current)}>{visible ? "⌄" : "⌃"}</button></div>
    {visible && <>
      {terminalReady && <div className="desktop-console-pane" hidden={tab !== "terminal"}><DesktopTerminal /></div>}
      {tab === "console" ? <>
      <div className="desktop-console-format" role="group" aria-label="输出格式"><button aria-pressed={!raw} onClick={() => setRaw(false)}>Markdown</button><button aria-pressed={raw} onClick={() => setRaw(true)}>原始输出</button></div>
      {!bridge && <div className="desktop-console-notice" role="status">命令执行不可用：未检测到桌面连接。浏览器预览不能执行本机命令；请使用 luban Desktop，若已在桌面版中请重启应用。</div>}
      <div className="desktop-console-output" ref={output}>{!commands.length && <p className="muted">一次性执行命令（不是沙箱）；需要交互、颜色或 cd 请切到「终端」。输出上限 1 MB，超过后自动停止。</p>}{commands.map(item => <div key={item.id}><div className="desktop-command-title"><b>$ {item.command}</b>{!item.exit && <button onClick={() => void bridge?.stopCommand(item.id).catch(cause => store.notify(desktopErrorText(cause), true))}>停止</button>}</div><ConsoleOutput text={item.output} raw={raw} />{item.exit && <small>{item.exit}</small>}</div>)}</div>
      <form className="desktop-command-input" onSubmit={event => { event.preventDefault(); void run(); }}><label htmlFor="desktop-command">命令 $</label><input id="desktop-command" ref={input} aria-label="控制台命令" autoComplete="off" spellCheck={false} placeholder={bridge ? "输入命令，按 Enter 运行（例如 git status）" : "需要 luban Desktop 桌面连接"} value={command} disabled={!bridge} onChange={event => setCommand(event.target.value)} onKeyDown={event => {
        if (event.key === "ArrowUp" && history.length) { event.preventDefault(); const index = Math.min(historyIndex + 1, history.length - 1); setHistoryIndex(index); setCommand(history[index]!); }
        if (event.key === "ArrowDown") { event.preventDefault(); const index = Math.max(historyIndex - 1, -1); setHistoryIndex(index); setCommand(index < 0 ? "" : history[index]!); }
      }} /><button disabled={!bridge || starting || !command.trim()}>运行</button></form>
    </> : <div className="desktop-console-output" hidden={tab !== "task"}>{store.job ? <><p><b>{store.job.title || store.job.id}</b> · {store.job.status}</p><p>模型：{store.node?.model} · 工作区：{store.job.workspace}</p><p>{store.job.instruction}</p>{store.job.logs.slice(-30).map((log, index) => <pre key={index}>{log.level} · {log.msg}</pre>)}{store.job.error && <p className="desktop-error">{store.job.error}</p>}</> : <p>在右侧提交任务后，这里显示运行状态与日志。</p>}</div>}
    </>}
  </section>;
}
