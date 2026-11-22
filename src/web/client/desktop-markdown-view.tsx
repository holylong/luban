import React from "react";
import { Markdown } from "./markdown";
import { previewSource } from "./desktop-markdown";

/**
 * Read-only rendering of the editor buffer. It takes the live content rather
 * than the saved file, so unsaved edits show up as you type — the whole point
 * of previewing inside the editor instead of opening the file elsewhere.
 */
export function MarkdownDocument({ path, content }: { path: string; content: string }): React.ReactElement {
  return <div className="desktop-markdown-doc" role="document" aria-label={`预览 ${path}`}>
    <article className="desktop-markdown-page">
      {content.trim()
        ? <Markdown text={previewSource(content)} />
        : <p className="desktop-markdown-empty">这个文件还是空的。切回编辑输入内容，预览会跟着更新。</p>}
    </article>
  </div>;
}
