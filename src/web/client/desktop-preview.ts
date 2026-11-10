// Models returned by the desktop main process for formats the text editor
// cannot open. Coordinates are CSS pixels; diagrams keep a viewBox so pages
// with negative coordinates still fit.

export interface SlideLine {
  text: string;
  x: number;
  y: number;
  size: number;
  align: "left" | "center" | "right";
  bold?: boolean;
  italic?: boolean;
  color?: string;
}

export interface SlideShape {
  kind: "rect" | "roundRect" | "ellipse" | "line" | "image";
  x: number;
  y: number;
  w: number;
  h: number;
  fill?: string;
  stroke?: string;
  strokeWidth?: number;
  rotation?: number;
  flipH?: boolean;
  flipV?: boolean;
  image?: string;
  lines?: SlideLine[];
}

export interface SlidePage { index: number; shapes: SlideShape[]; notes?: string }

export interface SlidesPreview {
  kind: "slides";
  path: string;
  width: number;
  height: number;
  slides: SlidePage[];
}

export interface DiagramNode {
  kind: "rect" | "roundRect" | "ellipse" | "text";
  x: number;
  y: number;
  w: number;
  h: number;
  fill?: string;
  stroke?: string;
  strokeWidth?: number;
  dashed?: boolean;
  fontSize: number;
  align: "left" | "center" | "right";
  color?: string;
  lines: string[];
}

export interface DiagramEdge {
  points: [number, number][];
  stroke?: string;
  strokeWidth?: number;
  dashed?: boolean;
  arrow?: boolean;
  label?: string;
}

export interface DiagramPage {
  name: string;
  view: { x: number; y: number; width: number; height: number };
  nodes: DiagramNode[];
  edges: DiagramEdge[];
}

export interface DiagramPreview { kind: "diagram"; path: string; pages: DiagramPage[] }

export interface SheetCell { text: string; numeric?: boolean }
export interface SheetRow { index: number; cells: (SheetCell | null)[] }
export interface SheetPage {
  name: string;
  columns: number;
  rows: SheetRow[];
  /** Rows and columns the backend hid to keep the preview bounded. */
  truncatedRows?: number;
  truncatedColumns?: number;
}
export interface SheetPreview { kind: "sheet"; path: string; sheets: SheetPage[] }

export type WordBlock =
  | { type: "heading"; level: number; text: string }
  | { type: "paragraph"; text: string }
  | { type: "list"; ordered?: boolean; items: string[] }
  | { type: "table"; rows: string[][] };

export interface WordPreview { kind: "word"; path: string; blocks: WordBlock[] }

export type DocumentPreview = SlidesPreview | DiagramPreview | SheetPreview | WordPreview;

/** Total text height of a label, used to centre wrapped lines in its shape. */
export function labelAnchor(node: DiagramNode): { x: number; top: number; lineHeight: number } {
  const lineHeight = Math.max(node.fontSize * 1.25, 6);
  const x = node.align === "left" ? node.x + 5 : node.align === "right" ? node.x + node.w - 5 : node.x + node.w / 2;
  return { x, top: node.y + (node.h - node.lines.length * lineHeight) / 2, lineHeight };
}

export function edgeLabelPoint(points: [number, number][]): [number, number] {
  if (!points.length) return [0, 0];
  const middle = Math.floor((points.length - 1) / 2);
  const [x1, y1] = points[middle]!;
  const [x2, y2] = points[middle + 1] ?? points[middle]!;
  return [(x1 + x2) / 2, (y1 + y2) / 2];
}
