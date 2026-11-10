import React from "react";
import { mediaEntrySource } from "./desktop-media";
import type { SlideLine, SlidePage, SlideShape, SlidesPreview } from "./desktop-preview";

const FONT = '"PingFang SC", "Hiragino Sans GB", "Microsoft YaHei", "Noto Sans CJK SC", sans-serif';

function rotationOf(shape: SlideShape): string | undefined {
  return shape.rotation ? `rotate(${shape.rotation} ${shape.x + shape.w / 2} ${shape.y + shape.h / 2})` : undefined;
}

function textAnchorOf(line: SlideLine): "start" | "middle" | "end" {
  return line.align === "center" ? "middle" : line.align === "right" ? "end" : "start";
}

function ShapeView({ path, shape }: { path: string; shape: SlideShape }): React.ReactElement | null {
  const transform = rotationOf(shape);
  if (shape.kind === "image") {
    if (!shape.image) return null;
    return <image href={mediaEntrySource(path, shape.image)} x={shape.x} y={shape.y} width={shape.w} height={shape.h}
      preserveAspectRatio="none" transform={transform} />;
  }
  if (shape.kind === "line") {
    const left = shape.flipH ? shape.x + shape.w : shape.x;
    const right = shape.flipH ? shape.x : shape.x + shape.w;
    const top = shape.flipV ? shape.y + shape.h : shape.y;
    const bottom = shape.flipV ? shape.y : shape.y + shape.h;
    return <line x1={left} y1={top} x2={right} y2={bottom} stroke={shape.stroke ?? "#000000"}
      strokeWidth={shape.strokeWidth ?? 1} transform={transform} />;
  }
  const stroke = shape.stroke ?? "none";
  const paint = { fill: shape.fill ?? "none", stroke, strokeWidth: shape.stroke ? shape.strokeWidth ?? 1 : 0 };
  return <g transform={transform}>
    {shape.kind === "ellipse"
      ? <ellipse cx={shape.x + shape.w / 2} cy={shape.y + shape.h / 2} rx={shape.w / 2} ry={shape.h / 2} {...paint} />
      : <rect x={shape.x} y={shape.y} width={shape.w} height={shape.h}
        rx={shape.kind === "roundRect" ? Math.min(shape.w, shape.h) * 0.12 : 0} {...paint} />}
    {shape.lines?.map((line, index) => <text key={index} x={line.x} y={line.y} fontSize={line.size}
      textAnchor={textAnchorOf(line)} fill={line.color ?? "#1A1A1A"} fontFamily={FONT}
      fontWeight={line.bold ? 600 : 400} fontStyle={line.italic ? "italic" : undefined}>{line.text}</text>)}
  </g>;
}

function SlideView({ preview, slide }: { preview: SlidesPreview; slide: SlidePage }): React.ReactElement {
  return <svg className="desktop-slide-canvas" viewBox={`0 0 ${preview.width} ${preview.height}`}
    role="img" aria-label={`第 ${slide.index} 页`} preserveAspectRatio="xMidYMid meet">
    <rect width={preview.width} height={preview.height} fill="#FFFFFF" />
    {slide.shapes.map((shape, index) => <ShapeView key={index} path={preview.path} shape={shape} />)}
  </svg>;
}

/** One read-only, scaled card per slide: a deck preview without PowerPoint. */
export function SlidesDocument({ preview }: { preview: SlidesPreview }): React.ReactElement {
  return <div className="desktop-deck">
    {preview.slides.map(slide => <figure className="desktop-slide" key={slide.index}>
      <figcaption>{`第 ${slide.index} / ${preview.slides.length} 页`}</figcaption>
      <SlideView preview={preview} slide={slide} />
      {slide.notes && <pre className="desktop-slide-notes">{`备注：${slide.notes}`}</pre>}
    </figure>)}
  </div>;
}
