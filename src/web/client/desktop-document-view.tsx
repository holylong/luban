import React from "react";
import type { DocumentPreviewKind } from "./desktop-media";
import type { DocumentPreview } from "./desktop-preview";
import { SlidesDocument } from "./desktop-deck-view";
import { DiagramDocument } from "./desktop-diagram-view";
import { SheetDocument } from "./desktop-sheet-view";
import { WordDocument } from "./desktop-word-view";
import { OpenExternalButton } from "./desktop-open-external";

const LABELS: Record<DocumentPreviewKind, string> = {
  slides: "幻灯片预览",
  diagram: "draw.io 图形预览",
  sheet: "表格预览",
  word: "文档预览",
};

/** Container for the parsed previews: loading, failure and the read-only hint
 * stay identical for every document kind, only the body changes. */
export function DesktopDocumentView({ path, kind, model, error, onClose }: {
  path: string;
  kind?: DocumentPreviewKind;
  model?: DocumentPreview;
  error?: string;
  onClose?(): void;
}): React.ReactElement {
  const label = LABELS[kind ?? model?.kind ?? "diagram"];
  return <div className="desktop-doc">
    <div className="desktop-doc-stage">
      {error ? <div className="desktop-doc-error" role="alert">{error}</div>
        : !model ? <div className="desktop-doc-loading">正在解析…</div>
          : model.kind === "slides" ? <SlidesDocument preview={model} />
            : model.kind === "sheet" ? <SheetDocument preview={model} />
              : model.kind === "word" ? <WordDocument preview={model} />
                : <DiagramDocument preview={model} />}
    </div>
    <div className="desktop-doc-hint">
      <span>{`${path} · ${label} · 只读，不参与编辑`}</span>
      <OpenExternalButton path={path} />
      {onClose && <button onClick={onClose}>关闭预览</button>}
    </div>
  </div>;
}
