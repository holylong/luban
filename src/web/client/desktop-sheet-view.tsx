import React, { useState } from "react";
import type { SheetPage, SheetPreview } from "./desktop-preview";

/** 0 -> A, 25 -> Z, 26 -> AA: the column reference spreadsheet users expect. */
export function columnLabel(index: number): string {
  let label = "";
  let value = index;
  while (value >= 0) {
    label = String.fromCharCode(65 + (value % 26)) + label;
    value = Math.floor(value / 26) - 1;
  }
  return label;
}

const truncated = (sheet: SheetPage): string | undefined => {
  if (!sheet.truncatedRows && !sheet.truncatedColumns) return undefined;
  const parts: string[] = [];
  if (sheet.truncatedRows) parts.push(`另有 ${sheet.truncatedRows} 行未显示`);
  if (sheet.truncatedColumns) parts.push(`另有 ${sheet.truncatedColumns} 个单元格未显示`);
  return `预览只显示前 ${sheet.rows.length} 行、${sheet.columns} 列，${parts.join("，")}`;
};

/** Read-only grid: one tab per worksheet, row/column headings like the source. */
export function SheetDocument({ preview }: { preview: SheetPreview }): React.ReactElement {
  const [active, setActive] = useState(0);
  const index = Math.min(active, preview.sheets.length - 1);
  const sheet = preview.sheets[index]!;
  const note = truncated(sheet);
  const columns = Array.from({ length: sheet.columns }, (_, position) => position);
  return <div className="desktop-sheet">
    {preview.sheets.length > 1 && <div className="desktop-sheet-tabs" role="tablist">
      {preview.sheets.map((item, position) => <button key={`${item.name}-${position}`} role="tab" aria-selected={position === index}
        className={position === index ? "active" : ""} onClick={() => setActive(position)}>{item.name}</button>)}
    </div>}
    <div className="desktop-sheet-scroll">
      <table className="desktop-sheet-table">
        <thead>
          <tr><th className="corner" aria-hidden="true" />{columns.map(position => <th key={position}>{columnLabel(position)}</th>)}</tr>
        </thead>
        <tbody>
          {sheet.rows.map(row => <tr key={row.index}>
            <th scope="row">{row.index}</th>
            {columns.map(position => {
              const cell = row.cells[position];
              return <td key={position} className={cell?.numeric ? "num" : ""}>{cell?.text ?? ""}</td>;
            })}
          </tr>)}
        </tbody>
      </table>
    </div>
    {note && <p className="desktop-sheet-note">{note}</p>}
  </div>;
}
