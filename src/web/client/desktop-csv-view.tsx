import React, { useMemo } from "react";
import { gridSummary, parseDelimited, type CsvGrid } from "./desktop-csv";

/**
 * Read-only table for a CSV/TSV buffer. Like the Markdown preview it renders the
 * live editor content, so unsaved edits show up without saving first, and it
 * parses on every keystroke only as far as the caps allow.
 */
export function CsvDocument({ path, content, grid }: { path: string; content: string; grid?: CsvGrid | null }): React.ReactElement {
  const parsed = useMemo(() => grid === undefined ? parseDelimited(content) : grid, [grid, content]);
  return <div className="desktop-csv" role="document" aria-label={`预览 ${path}`}>
    {parsed
      ? <>
        <div className="desktop-csv-scroll">
          <table className="desktop-csv-table">
            <thead>
              <tr><th className="corner" aria-hidden="true" />{parsed.header.map((title, position) => <th key={position} scope="col">{title}</th>)}</tr>
            </thead>
            <tbody>
              {parsed.rows.map(row => <tr key={row.index}>
                <th scope="row">{row.index}</th>
                {row.cells.map((cell, position) => <td key={position} className={cell.numeric ? "num" : ""}>{cell.text}</td>)}
              </tr>)}
            </tbody>
          </table>
        </div>
        <p className="desktop-csv-note">{gridSummary(parsed)}</p>
      </>
      : <p className="desktop-csv-empty">这个文件还是空的。切回编辑输入内容，表格会跟着更新。</p>}
  </div>;
}
