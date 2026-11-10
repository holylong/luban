import React from "react";
import type { DocumentPreviewKind } from "./desktop-media";
import type { DocumentPreview } from "./desktop-preview";
import { SlidesDocument } from "./desktop-deck-view";
import { DiagramDocument } from "./desktop-diagram-view";
import { OpenExternalButton } from "./desktop-open-external";

/** Container for the parsed previews: loading, failure and the read-only hint
 * stay identical for decks and diagrams, only the body changes. */
export function DesktopDocumentView({ path, kind, model, error, onClose }: {
  path: string;
  kind?: DocumentPreviewKind;
  model?: DocumentPreview;
  error?: string;
  onClose?(): void;
}): React.ReactElement {
  const label = (kind ?? model?.kind) === "slides" ? "幻灯片预览" : "draw.io 图形预览";
  return <div className="desktop-doc">
    <div className="desktop-doc-stage">
      {error ? <div className="desktop-doc-error" role="alert">{error}</div>
        : !model ? <div className="desktop-doc-loading">正在解析…</div>
          : model.kind === "slides" ? <SlidesDocument preview={model} />
            : <DiagramDocument preview={model} />}
    </div>
    <div className="desktop-doc-hint">
      <span>{`${path} · ${label} · 只读，不参与编辑`}</span>
      <OpenExternalButton path={path} />
      {onClose && <button onClick={onClose}>关闭预览</button>}
    </div>
  </div>;
}
