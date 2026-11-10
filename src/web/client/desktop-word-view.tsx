import React from "react";
import type { WordBlock, WordPreview } from "./desktop-preview";

const HEADINGS = { 1: "h1", 2: "h2", 3: "h3" } as const;

function block(entry: WordBlock, key: number): React.ReactElement {
  if (entry.type === "heading") {
    const Tag = HEADINGS[Math.min(Math.max(entry.level, 1), 3) as 1 | 2 | 3];
    return <Tag key={key}>{entry.text}</Tag>;
  }
  if (entry.type === "list") {
    const items = entry.items.map((text, position) => <li key={position}>{text}</li>);
    return entry.ordered ? <ol key={key}>{items}</ol> : <ul key={key}>{items}</ul>;
  }
  if (entry.type === "table") {
    return <table key={key}><tbody>
      {entry.rows.map((row, position) => <tr key={position}>
        {row.map((cell, column) => <td key={column}>{cell}</td>)}
      </tr>)}
    </tbody></table>;
  }
  return <p key={key}>{entry.text}</p>;
}

/** Read-only article: headings, paragraphs, lists and tables in document order. */
export function WordDocument({ preview }: { preview: WordPreview }): React.ReactElement {
  return <article className="desktop-word">
    {preview.blocks.map((entry, index) => block(entry, index))}
  </article>;
}
