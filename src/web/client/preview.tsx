import React, { useMemo } from "react";
import { HighlightedLine, Markdown } from "./markdown";
import { parseEditRecord, relativeTime, toolLabel } from "./timeline";
import type { DiffPayload, FileContent, SessionDetail } from "./types";

export interface DiffLineRow { kind: "add" | "del" | "ctx" | "hunk" | "meta"; text: string }
export interface DiffFile { path: string; rows: DiffLineRow[] }

/** Split a unified diff into per-file rows without assuming git specifics. */
export function parseUnifiedDiff(patch: string, limit = 4000): DiffFile[] {
  if (!patch.trim()) return [];
  const files: DiffFile[] = [];
  let current: DiffFile | undefined;
  let counted = 0;
  for (const raw of (patch || "").split("\n")) {
    const fileHeader = /^diff --git a\/(.*?) b\/(.*)$/u.exec(raw);
    if (fileHeader) {
      current = { path: fileHeader[2] || fileHeader[1] || "", rows: [] };
      files.push(current);
      continue;
    }
    if (!current) {
      current = { path: "", rows: [] };
      files.push(current);
    }
    if (counted++ > limit) { current.rows.push({ kind: "meta", text: "… diff truncated for display" }); break; }
    if (raw.startsWith("+++") || raw.startsWith("---") || raw.startsWith("index ") || raw.startsWith("new file") || raw.startsWith("deleted file") || raw.startsWith("similarity")) {
      current.rows.push({ kind: "meta", text: raw });
      continue;
    }
    if (raw.startsWith("@@")) { current.rows.push({ kind: "hunk", text: raw }); continue; }
    if (raw.startsWith("+")) { current.rows.push({ kind: "add", text: raw.slice(1) }); continue; }
    if (raw.startsWith("-")) { current.rows.push({ kind: "del", text: raw.slice(1) }); continue; }
    current.rows.push({ kind: "ctx", text: raw.startsWith(" ") ? raw.slice(1) : raw });
  }
  return files.filter(file => file.rows.length || file.path);
}

function FileView({ file }: { file: FileContent }): React.ReactElement {
  const lines = useMemo(() => (file.binary ? [] : file.content.replace(/\n$/u, "").split("\n")), [file]);
  return (
    <>
      <div className="banner">
        <span className="muted">{file.path}</span>
        <span className="muted"> · {file.size < 1024 ? `${file.size} B` : `${(file.size / 1024).toFixed(1)} KB`}</span>
        {file.lines !== undefined && <span className="muted"> · {file.lines} 行</span>}
        {file.truncated && <span className="chip" style={{ marginLeft: 8 }}>已截断</span>}
      </div>
      {file.binary
        ? <div className="banner">二进制文件，未在浏览器中渲染。</div>
        : (
          <div className="code">
            {lines.map((line, index) => (
              <div className="code-row" key={index}>
                <span className="ln">{index + 1}</span>
                <span className="src"><HighlightedLine line={line} language={file.language} /></span>
              </div>
            ))}
          </div>
        )}
    </>
  );
}

function DiffView({ diff, onOpen }: { diff: DiffPayload; onOpen: (path: string) => void }): React.ReactElement {
  const files = useMemo(() => parseUnifiedDiff(diff.patch), [diff.patch]);
  if (!diff.available) return <div className="banner">无法读取 Git 变更：{diff.error || "不是 Git 仓库或没有提交"}</div>;
  return (
    <>
      <div className="banner">
        相对 Git HEAD 的工作区变更 · {diff.files.length} 个文件
      </div>
      {diff.files.map(entry => (
        <div className="difffile" key={entry.path}>
          <span className={`status ${entry.status.slice(0, 1)}`}>{entry.status.slice(0, 1)}</span>
          <span>{entry.path}</span>
          <button onClick={() => onOpen(entry.path)}>打开</button>
        </div>
      ))}
      <div className="code">
        {files.map((file, fileIndex) => (
          <React.Fragment key={`${file.path}-${fileIndex}`}>
            {file.path && <div className="code-row"><span className="ln" /><span className="src hunk">{file.path}</span></div>}
            {file.rows.map((row, index) => (
              <div className={`code-row ${row.kind === "add" ? "add" : row.kind === "del" ? "del" : ""}`} key={index}>
                <span className="ln">{row.kind === "hunk" ? "" : row.kind === "add" ? "+" : row.kind === "del" ? "−" : " "}</span>
                <span className={`src ${row.kind === "hunk" ? "hunk" : row.kind === "meta" ? "muted" : ""}`}>
                  {row.kind === "hunk" || row.kind === "meta" ? row.text : <HighlightedLine line={row.text} />}
                </span>
              </div>
            ))}
          </React.Fragment>
        ))}
      </div>
    </>
  );
}

function SessionView({ session }: { session: SessionDetail }): React.ReactElement {
  const edits = session.edits ?? [];
  return (
    <>
      <div className="banner">
        <div style={{ fontWeight: 600 }}>{session.title}</div>
        <div className="muted" style={{ fontSize: 11.5 }}>
          {session.model} · {session.mode} · 更新于 {relativeTime(Date.parse(session.updatedAt) / 1000)} · {session.messages.length} 条消息 · 编辑记录 {edits.length}
        </div>
      </div>
      <div style={{ padding: "0 12px 20px" }}>
        {edits.length > 0 && (
          <div style={{ marginTop: 10 }}>
            <div className="section">编辑记录</div>
            {edits.map(edit => {
              const rows = parseEditRecord(edit.preview);
              const added = rows.filter(row => row.kind === "add").length;
              const removed = rows.filter(row => row.kind === "remove").length;
              return (
                <div className="difffile" key={edit.id}>
                  <span className="status M">{toolLabel(edit.name).slice(0, 1)}</span>
                  <span>{rows.find(row => row.kind === "header")?.text || edit.id}</span>
                  <span className="chip add">+{added}</span>
                  <span className="chip del">−{removed}</span>
                </div>
              );
            })}
          </div>
        )}
        <div className="section">完整对话</div>
        {session.messages.filter(message => message.role !== "system" && !message.tool_calls?.length).map((message, index) => (
          <div className="session-msg" key={index}>
            <div className="role">{message.role === "user" ? (message.name || "user") : message.role === "tool" ? `tool${message.tool_call_id ? ` · ${message.tool_call_id}` : ""}` : message.role}</div>
            {message.role === "assistant"
              ? <div className="content"><Markdown text={message.content || ""} /></div>
              : <div className="content">{message.editPreview || message.content}</div>}
          </div>
        ))}
      </div>
    </>
  );
}

/** Structural subset of the store that the preview panel needs. */
export interface WorkbenchStoreLike {
  previewTab: "files" | "diff" | "session";
  file?: FileContent;
  fileError?: string;
  diff?: DiffPayload;
  session?: SessionDetail;
  setPreviewTab: (tab: "files" | "diff" | "session") => void;
  openFile: (path: string) => Promise<void>;
  refreshDiff: () => Promise<void>;
}

export function Preview({ store }: { store: WorkbenchStoreLike }): React.ReactElement {
  return (
    <>
      <div className="tabs-bar">
        <button className={store.previewTab === "files" ? "active" : ""} onClick={() => store.setPreviewTab("files")}>文件</button>
        <button className={store.previewTab === "diff" ? "active" : ""} onClick={() => void store.refreshDiff()}>变更</button>
        {store.session && <button className={store.previewTab === "session" ? "active" : ""} onClick={() => store.setPreviewTab("session")}>会话</button>}
      </div>
      <div className="preview-body">
        {store.previewTab === "files" && (store.file
          ? <FileView file={store.file} />
          : <div className="banner">{store.fileError || "从文件树选择一个文件。"}</div>)}
        {store.previewTab === "diff" && (store.diff
          ? <DiffView diff={store.diff} onOpen={path => void store.openFile(path)} />
          : <div className="banner">正在读取 Git 变更…</div>)}
        {store.previewTab === "session" && store.session && <SessionView session={store.session} />}
      </div>
    </>
  );
}
