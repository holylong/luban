import React from "react";
import { edgeLabelPoint, labelAnchor, type DiagramEdge, type DiagramPage, type DiagramPreview } from "./desktop-preview";

const FONT = '"PingFang SC", "Hiragino Sans GB", "Microsoft YaHei", "Noto Sans CJK SC", sans-serif';

function EdgeView({ edge, marker }: { edge: DiagramEdge; marker: string }): React.ReactElement {
  const label = edge.label ? edgeLabelPoint(edge.points) : undefined;
  return <g>
    <polyline points={edge.points.map(point => point.join(",")).join(" ")} fill="none"
      stroke={edge.stroke ?? "#000000"} strokeWidth={edge.strokeWidth ?? 1}
      strokeDasharray={edge.dashed ? "6 4" : undefined} strokeLinejoin="round" strokeLinecap="round"
      markerEnd={edge.arrow ? `url(#${marker})` : undefined} />
    {label && <text x={label[0]} y={label[1] - 4} fontSize={11} textAnchor="middle" fill="#333333" fontFamily={FONT}>{edge.label}</text>}
  </g>;
}

/** Read-only draw.io page: vertices as shapes with wrapped labels, edges as
 * polylines, all inside the page's own viewBox so it scales to the pane. */
export function DiagramDocument({ preview }: { preview: DiagramPreview }): React.ReactElement {
  return <div className="desktop-diagram-list">
    {preview.pages.map((page, index) => <figure className="desktop-diagram" key={`${page.name}-${index}`}>
      {preview.pages.length > 1 && <figcaption>{page.name || `页面 ${index + 1}`}</figcaption>}
      <DiagramPageView page={page} />
    </figure>)}
  </div>;
}

function DiagramPageView({ page }: { page: DiagramPage }): React.ReactElement {
  const marker = `arrow-${React.useId().replace(/[^a-zA-Z0-9-]/g, "")}`;
  const { x, y, width, height } = page.view;
  return <svg className="desktop-diagram-canvas" viewBox={`${x} ${y} ${Math.max(width, 1)} ${Math.max(height, 1)}`}
    role="img" aria-label={page.name || "draw.io 图形"} preserveAspectRatio="xMidYMid meet">
    <defs>
      <marker id={marker} viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
        <path d="M0,0 L10,5 L0,10 z" fill="context-stroke" />
      </marker>
    </defs>
    {page.edges.map((edge, index) => <EdgeView key={index} edge={edge} marker={marker} />)}
    {page.nodes.map((node, index) => {
      const anchor = labelAnchor(node);
      const stroke = node.stroke ?? "none";
      return <g key={index}>
        {node.kind === "ellipse"
          ? <ellipse cx={node.x + node.w / 2} cy={node.y + node.h / 2} rx={node.w / 2} ry={node.h / 2}
            fill={node.fill ?? "none"} stroke={stroke} strokeWidth={node.stroke ? node.strokeWidth ?? 1 : 0}
            strokeDasharray={node.dashed ? "6 4" : undefined} />
          : node.kind === "text" ? null
          : <rect x={node.x} y={node.y} width={node.w} height={node.h}
            rx={node.kind === "roundRect" ? Math.min(12, node.h / 2) : 0}
            fill={node.fill ?? "none"} stroke={stroke} strokeWidth={node.stroke ? node.strokeWidth ?? 1 : 0}
            strokeDasharray={node.dashed ? "6 4" : undefined} />}
        {node.lines.map((line, lineIndex) => <text key={lineIndex} x={anchor.x}
          y={anchor.top + lineIndex * anchor.lineHeight + node.fontSize}
          textAnchor={node.align === "left" ? "start" : node.align === "right" ? "end" : "middle"}
          fontSize={node.fontSize} fill={node.color ?? "#000000"} fontFamily={FONT}
          stroke={node.kind === "text" ? undefined : node.fill && node.fill !== "none" ? node.fill : undefined}
          strokeWidth={node.kind === "text" ? undefined : 4} paintOrder="stroke">{line}</text>)}
      </g>;
    })}
  </svg>;
}
