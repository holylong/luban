import React, { useEffect, useLayoutEffect, useRef, useState } from "react";
import { acceptSaved, quickMatches, type EditorDocument } from "./desktop-bridge";
import type { WorkbenchStore } from "./store";

export function DesktopEditor({ store, activeView = true }: { store: WorkbenchStore; activeView?: boolean }): React.ReactElement {
  const bridge = window.lubanDesktop;
  const [documents, setDocuments] = useState<EditorDocument[]>([]);
  const [active, setActive] = useState("");
  const [saving, setSaving] = useState(false);
  const [quick, setQuick] = useState(false);
  const [query, setQuery] = useState("");
  const [files, setFiles] = useState<string[]>([]);
  const [error, setError] = useState("");
  const [position, setPosition] = useState({ line: 1, column: 1 });
  const area = useRef<HTMLTextAreaElement>(null);
  const gutter = useRef<HTMLPreElement>(null);
  const opening = useRef(0);
  const document = documents.find(item => item.path === active);
  const dirty = documents.some(item => item.content !== item.saved);
  const notify = store.notify;

  const open = async (path: string): Promise<void> => {
    if (!bridge) return;
    const request = ++opening.current;
    if (documents.some(item => item.path === path)) { setActive(path); return; }
    try {
      const file = await bridge.readFile(path);
      setDocuments(current => current.some(item => item.path === path) ? current : [...current, { ...file, saved: file.content }]);
      if (request === opening.current) { setActive(path); setError(""); }
    } catch (cause) { setError(String(cause)); }
  };
  useEffect(() => { if (store.file?.path) void open(store.file.path); }, [store.file?.path]); // Each selected file is loaded once, never over a dirty buffer.
  useLayoutEffect(() => { bridge?.setDirty(dirty); }, [bridge, dirty]);

  const save = async (): Promise<void> => {
    if (!document || !bridge || saving) return;
    const snapshot = document;
    setSaving(true);
    try {
      const result = await bridge.saveFile(snapshot);
      setDocuments(current => current.map(item => item.path === snapshot.path ? acceptSaved(item, result) : item));
      setError(""); notify(`已保存 ${snapshot.path}`);
    } catch (cause) { setError(`${String(cause)}。若磁盘已修改，请先复制当前内容，再重新读取磁盘版本。`); }
    finally { setSaving(false); }
  };
  const showQuick = (): void => {
    setQuick(true); setQuery("");
    void bridge?.listFiles().then(setFiles).catch(cause => setError(String(cause)));
  };
  useEffect(() => {
    const key = (event: KeyboardEvent): void => {
      if (!activeView || !(event.metaKey || event.ctrlKey)) return;
      if (event.key.toLowerCase() === "s") { event.preventDefault(); void save(); }
      if (event.key.toLowerCase() === "p") { event.preventDefault(); showQuick(); }
      if (event.key.toLowerCase() === "w" && document) { event.preventDefault(); close(document); }
    };
    window.addEventListener("keydown", key);
    return () => window.removeEventListener("keydown", key);
  });
  const close = (item: EditorDocument): void => {
    if (item.saved !== item.content && !window.confirm(`放弃 ${item.path} 的未保存更改？`)) return;
    const next = documents.filter(entry => entry.path !== item.path);
    setDocuments(next);
    if (active === item.path) setActive(next.at(-1)?.path ?? "");
  };
  const change = (content: string): void => setDocuments(current => current.map(item => item.path === active ? { ...item, content } : item));
  const locate = (): void => {
    const input = area.current;
    if (!input) return;
    const before = input.value.slice(0, input.selectionStart).split("\n");
    setPosition({ line: before.length, column: before.at(-1)!.length + 1 });
  };
  const matches = quickMatches(files, query);

  return <>
    <div className="desktop-editor-head"><span className="desktop-editor-title">{active || "代码工作台"}</span><button onClick={showQuick} disabled={!bridge}>快速打开 ⌘/Ctrl P</button><button onClick={() => void save()} disabled={!document || saving || document.saved === document.content}>{saving ? "保存中…" : "保存"}</button></div>
    <div className="desktop-document-tabs" role="tablist" aria-label="打开的文件">{documents.map(item => <div key={item.path} className={active === item.path ? "active" : ""}><button role="tab" aria-selected={active === item.path} title={item.path} onClick={() => setActive(item.path)}>{item.content !== item.saved ? "● " : ""}{item.path.split("/").at(-1)}</button><button aria-label={`关闭 ${item.path}`} onClick={() => close(item)}>×</button></div>)}</div>
    {error && <div className="desktop-error">{error}{document && <button onClick={async () => {
      if (!window.confirm("重新读取磁盘版本会放弃当前文件未保存内容，继续？")) return;
      try { const file = await bridge!.readFile(active); setDocuments(current => current.map(item => item.path === file.path ? { ...file, saved: file.content } : item)); setError(""); } catch (cause) { setError(String(cause)); }
    }}>重新读取磁盘</button>}</div>}
    {document ? <>
      <div className="desktop-code-editor"><pre className="desktop-line-numbers" ref={gutter} aria-hidden="true">{document.content.split("\n").map((_, index) => index + 1).join("\n")}</pre><textarea key={active} ref={area} aria-label={`编辑 ${active}`} value={document.content} spellCheck={false} autoCapitalize="off" autoCorrect="off" wrap="off" onChange={event => change(event.target.value)} onSelect={locate} onScroll={event => { if (gutter.current) gutter.current.scrollTop = event.currentTarget.scrollTop; }} onKeyDown={event => {
        if (event.key === "Tab") {
          event.preventDefault();
          const input = event.currentTarget;
          const start = input.selectionStart;
          input.setRangeText("  ", start, input.selectionEnd, "end");
          change(input.value); locate();
        }
      }} /></div>
      <div className="desktop-editor-info"><span>Ln {position.line}, Col {position.column}</span><span>UTF-8 · {active.split(".").at(-1)} · {document.content === document.saved ? "已保存" : "未保存"}</span><button onClick={() => { void store.submit(`请检查文件 ${active} 的代码，先解释问题和建议，不要修改文件。${document.content !== document.saved ? "注意：编辑器中存在尚未保存的更改，请先提醒我保存。" : ""}`); }}>让助手检查文件</button></div>
    </> : <div className="desktop-welcome"><span className="desktop-mark">L</span><h1>luban 工作台</h1><p>左侧浏览文件，中间编辑代码，右侧与助手协作。</p><button onClick={showQuick} disabled={!bridge}>打开文件 · ⌘/Ctrl P</button><p>⌘/Ctrl S 保存 · ⌘/Ctrl K 新任务 · ⌘/Ctrl ` 控制台</p>{!bridge && <p>代码编辑和命令执行仅在 Electron 桌面客户端可用。</p>}</div>}
    {quick && <div className="desktop-quick-backdrop" onClick={() => setQuick(false)}><section className="desktop-quick" role="dialog" aria-label="快速打开文件" onClick={event => event.stopPropagation()}><input autoFocus aria-label="搜索项目文件" placeholder="输入文件名或路径…（最多索引 5000 个文件）" value={query} onChange={event => setQuery(event.target.value)} onKeyDown={event => { if (event.key === "Escape") setQuick(false); if (event.key === "Enter" && matches[0]) { void open(matches[0]); setQuick(false); } }} /><div>{matches.map(path => <button key={path} onClick={() => { void open(path); setQuick(false); }}>{path}</button>)}{!matches.length && <p>没有匹配文件</p>}</div></section></div>}
  </>;
}
