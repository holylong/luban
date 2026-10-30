import React from "react";
import { HighlightedLine } from "./markdown";

/** Past these bounds a file stays plain text so typing never re-tokenizes a huge buffer. */
export const MAX_HIGHLIGHT_CHARS = 200_000;
export const MAX_HIGHLIGHT_LINES = 5_000;

/** Language id for `tokenize`, taken from the file name the way the preview does. */
export function editorLanguage(path: string): string {
  const name = path.split("/").at(-1) ?? "";
  if (!name) return "";
  const dot = name.lastIndexOf(".");
  return (dot > 0 ? name.slice(dot + 1) : dot === 0 ? name.slice(1) : name).toLowerCase();
}

export function highlightable(content: string): boolean {
  return content.length <= MAX_HIGHLIGHT_CHARS && content.split("\n").length <= MAX_HIGHLIGHT_LINES;
}

/**
 * Every line is tokenized on its own and painted as text inside a `<pre>`, so the
 * layer keeps the exact line breaks of the buffer without any HTML injection.
 */
export const HighlightedCode = React.memo(function HighlightedCode({ content, language }: { content: string; language: string }): React.ReactElement {
  const lines = content.split("\n");
  return <>{lines.map((line, index) => (
    <React.Fragment key={index}>
      <HighlightedLine line={line} language={language} />
      {index < lines.length - 1 ? "\n" : null}
    </React.Fragment>
  ))}</>;
});
