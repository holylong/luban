import React, { useMemo, useState } from "react";
import { editDisplayRows, editRecordStats, formatDuration, parseEditRecord, toolLabel } from "./timeline";
import type { EditCell } from "./timeline";
import type { ToolRun } from "./types";
import { HighlightedLine } from "./markdown";

/** One side of a split row: line number, sign, and the code. */
function EditCellView({ cell, side }: { cell: EditCell; side: "left" | "right" }): React.ReactElement {
  const sign = cell.kind === "add" ? "+" : cell.kind === "remove" ? "−" : "";
  // Bound only what is drawn: the stored record keeps the full line.
  const text = cell.text.length > 400 ? `${cell.text.slice(0, 400)}…` : cell.text;
  return (
    <div className={`edit-cell ${cell.kind} ${side}`}>
      <span className="ln">{cell.line ?? ""}</span>
      <span className="sign">{sign}</span>
      <span className="code">{cell.kind === "empty" ? "" : <HighlightedLine line={text} />}</span>
    </div>
  );
}

/** The inline execution record for one file mutation, removed left / added right. */
export function EditRecord({ preview }: { preview: string }): React.ReactElement {
  const parsed = useMemo(() => parseEditRecord(preview), [preview]);
  const rows = useMemo(() => editDisplayRows(parsed), [parsed]);
  const stats = useMemo(() => editRecordStats(parsed), [parsed]);
  return (
    <div className="edit-record">
      <div className="edit-summary">
        <span className="path">{stats.path || "unknown file"}</span>
        <span className="chip add">+{stats.added}</span>
        <span className="chip del">−{stats.removed}</span>
        {stats.firstLine !== undefined && (
          <span className="chip range">
            {stats.firstLine === stats.lastLine ? `L${stats.firstLine}` : `L${stats.firstLine}–${stats.lastLine}`}
          </span>
        )}
      </div>
      <div className="edit-split">
        {rows.map((row, index) => {
          if (row.kind === "header") return <div className="edit-split-head" key={index}>{row.text}</div>;
          if (row.kind === "meta") return <div className="edit-meta" key={index}>{row.text}</div>;
          return (
            <div className="edit-split-row" key={index}>
              <EditCellView cell={row.left} side="left" />
              <EditCellView cell={row.right} side="right" />
            </div>
          );
        })}
      </div>
    </div>
  );
}

function nameClass(name: string): string {
  if (name === "bash") return "bash";
  if (/^(edit_file|write_file|apply_patch)$/u.test(name)) return "edit";
  if (/^(read_file|list_dir|glob_files|grep_files|read_image)$/u.test(name)) return "read";
  return "";
}

export function ToolCard({ run, defaultOpen }: { run: ToolRun; defaultOpen: boolean }): React.ReactElement {
  const [open, setOpen] = useState(defaultOpen);
  const hasBody = Boolean(run.editPreview || run.preview);
  return (
    <div className={`tool ${run.status}`}>
      <button className="tool-head" onClick={() => setOpen(value => !value)} aria-expanded={open}>
        <span className={`tool-name ${nameClass(run.name)}`}>{toolLabel(run.name)}</span>
        <span className="tool-summary">{run.summary || run.name}</span>
        <span className={`tool-status ${run.status === "done" ? "ok" : run.status === "failed" ? "bad" : ""}`}>
          {run.status === "running" ? "执行中" : run.status === "failed" ? `失败${run.elapsedMs === undefined ? "" : ` · ${formatDuration(run.elapsedMs)}`}` : `完成${run.elapsedMs === undefined ? "" : ` · ${formatDuration(run.elapsedMs)}`}`}
        </span>
        <span className="muted">{hasBody ? (open ? "▾" : "▸") : ""}</span>
      </button>
      {open && (
        <div className="tool-body">
          {run.name === "bash" && Boolean(run.args.command) && (
            <pre className="tool-args">$ {String(run.args.command)}</pre>
          )}
          {run.editPreview
            ? <EditRecord preview={run.editPreview} />
            : run.preview ? <pre className="tool-preview">{run.preview}</pre> : null}
        </div>
      )}
    </div>
  );
}
