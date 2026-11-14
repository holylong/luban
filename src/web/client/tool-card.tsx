import React, { useMemo, useState } from "react";
import { editDisplayRows, editRecordStats, formatDuration, parseEditRecord, toolLabel } from "./timeline";
import type { EditCell, EditRecordRow } from "./timeline";
import type { ToolRun } from "./types";
import { HighlightedLine } from "./markdown";
import { useElementWidth } from "./use-element-width";

/** Bound only what is drawn: the stored record keeps the full line. */
function boundLine(text: string): string {
  return text.length > 400 ? `${text.slice(0, 400)}…` : text;
}

/**
 * Two columns need two readable columns: below this the side-by-side view
 * wrapped every line two or three times, which is what made the record look
 * ragged and unaligned.
 */
export const SPLIT_MIN_WIDTH = 900;

/** Side-by-side only when the record has the width for both halves. */
export function editRecordLayout(layout: "auto" | "split" | "unified", width: number): "split" | "unified" {
  if (layout === "split") return "split";
  if (layout === "unified") return "unified";
  return width >= SPLIT_MIN_WIDTH ? "split" : "unified";
}

function EditCellView({ cell, side }: { cell: EditCell; side: "left" | "right" }): React.ReactElement {
  const sign = cell.kind === "add" ? "+" : cell.kind === "remove" ? "−" : "";
  return (
    <div className={`edit-cell ${cell.kind} ${side}`}>
      <span className="ln">{cell.line ?? ""}</span>
      <span className="sign">{sign}</span>
      <span className="code">{cell.kind === "empty" ? "" : <HighlightedLine line={boundLine(cell.text)} />}</span>
    </div>
  );
}

/** One unified row: number, sign and text in fixed columns, exactly like the phone. */
function EditRowView({ row }: { row: EditRecordRow }): React.ReactElement {
  if (row.kind === "header") return <div className="edit-lines-head">{row.raw ?? `Edited ${row.text}`}</div>;
  if (row.kind === "meta") return <div className="edit-meta">{row.text}</div>;
  const sign = row.kind === "add" ? "+" : row.kind === "remove" ? "−" : "";
  return (
    <div className={`edit-line ${row.kind}`}>
      <span className="ln">{row.line ?? ""}</span>
      <span className="sign">{sign}</span>
      <span className="code"><HighlightedLine line={boundLine(row.text)} /></span>
    </div>
  );
}

/** The inline execution record for one file mutation: header, then the change. */
export function EditRecord({ preview, layout = "auto" }: {
  preview: string;
  /** "auto" picks side-by-side only when both halves can show a whole line. */
  layout?: "auto" | "split" | "unified";
}): React.ReactElement {
  const parsed = useMemo(() => parseEditRecord(preview), [preview]);
  const rows = useMemo(() => editDisplayRows(parsed), [parsed]);
  const stats = useMemo(() => editRecordStats(parsed), [parsed]);
  const [ref, width] = useElementWidth<HTMLDivElement>();
  const mode = editRecordLayout(layout, width);
  return (
    <div className="edit-record" ref={ref} data-layout={mode}>
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
      {mode === "split"
        ? <div className="edit-split">
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
        : <div className="edit-lines">{parsed.map((row, index) => <EditRowView row={row} key={index} />)}</div>}
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
