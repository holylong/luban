const { inflateRawSync, inflateSync } = require("node:zlib");
const { parseXml, child, children, findAll, decodeEntities } = require("./xml.cjs");
const { wrapText } = require("./text-wrap.cjs");

// draw.io stores a diagram in three shapes: plain XML (.drawio), an escaped
// <content> block (.drawio.svg) and a deflated tEXt/zTXt chunk (.drawio.png).
// Compressed pages inside <diagram> are base64(deflateRaw(encodeURIComponent)).

function extractXml(text) {
  if (typeof text !== "string" || !text.trim()) return undefined;
  const mxfile = text.indexOf("<mxfile");
  if (mxfile >= 0) return text.slice(mxfile);
  const model = text.indexOf("<mxGraphModel");
  if (model >= 0) return text.slice(model);
  const content = /<content\b[^>]*>([\s\S]*?)<\/content>/i.exec(text);
  if (content && /(?:&lt;|<)mx(?:file|GraphModel)/.test(content[1])) return decodeEntities(content[1]).trim();
  const attribute = /\bcontent\s*=\s*"([^"]*)"/i.exec(text);
  if (attribute && /&lt;mx(?:file|GraphModel)|<mx(?:file|GraphModel)/.test(attribute[1])) return decodeEntities(attribute[1]).trim();
  return undefined;
}

function inflatePage(payload) {
  const raw = String(payload || "").trim();
  if (!raw) throw new Error("draw.io 页面内容为空");
  if (raw.startsWith("<")) return raw;
  try { return decodeURIComponent(inflateRawSync(Buffer.from(raw, "base64")).toString("utf8")); }
  catch { throw new Error("draw.io 页面内容无法解压"); }
}

function embeddedXml(buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.length < 8) return undefined;
  let offset = 8;
  while (offset + 8 <= buffer.length) {
    const length = buffer.readUInt32BE(offset);
    const type = buffer.toString("latin1", offset + 4, offset + 8);
    const start = offset + 8;
    const end = start + length;
    if (end > buffer.length) break;
    if (type === "tEXt" || type === "zTXt") {
      const data = buffer.subarray(start, end);
      const zero = data.indexOf(0);
      if (zero > 0 && data.toString("latin1", 0, zero) === "mxfile") {
        if (type === "tEXt") return data.toString("utf8", zero + 1);
        if (data[zero + 1] === 0) return inflateSync(data.subarray(zero + 2)).toString("utf8");
      }
    }
    offset = end + 4;
    if (type === "IEND") break;
  }
  return undefined;
}

function styleOf(cell) {
  const style = new Map();
  for (const part of String(cell.attrs.style || "").split(";")) {
    const equals = part.indexOf("=");
    if (equals < 0) {
      const flag = part.trim();
      if (flag) style.set(flag, "1");
      continue;
    }
    style.set(part.slice(0, equals).trim(), part.slice(equals + 1).trim());
  }
  return style;
}

function colorOf(value) {
  if (!value) return undefined;
  const clean = value.trim();
  if (!clean || clean === "none") return undefined;
  if (clean.startsWith("#")) return /^#[0-9a-fA-F]{3,8}$/.test(clean) ? clean : undefined;
  return /^[a-zA-Z]+$/.test(clean) ? clean : undefined;
}

/** draw.io treats a missing paint as white fill / black stroke, but an explicit
 *  "none" must stay empty and group containers must not hide their children. */
function paintOf(style, key, fallback) {
  const value = style.get(key);
  if (value === "none") return undefined;
  if (!value || value === "default") return fallback;
  return colorOf(value);
}

function alignOf(value) {
  if (value === "left") return "left";
  if (value === "right") return "right";
  return "center";
}

/** mxCell labels are HTML when html=1; the preview paints plain text lines. */
function plainLabel(value) {
  if (typeof value !== "string" || !value) return "";
  const text = decodeEntities(value
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/(?:div|p|li|tr)>/gi, "\n")
    .replace(/<[^>]*>/g, ""));
  return text.replace(/\u00a0/g, " ").replace(/\n{3,}/g, "\n\n").trim();
}

function cellsOf(model) {
  const found = [];
  const visit = node => {
    for (const item of node.children) {
      if (item.name === "UserObject" || item.name === "object") {
        const label = item.attrs.label ?? item.attrs.id;
        const inner = child(item, "mxCell");
        if (inner) found.push({ ...inner, attrs: { ...inner.attrs, value: inner.attrs.value ?? label } });
        visit(item);
        continue;
      }
      if (item.name === "mxCell") found.push(item);
      visit(item);
    }
  };
  visit(model);
  return found;
}

function pageOf(model, name) {
  const cells = cellsOf(model);
  const byId = new Map();
  for (const cell of cells) if (cell.attrs.id) byId.set(cell.attrs.id, cell);

  const positions = new Map();
  const absolute = (cell, depth = 0) => {
    const key = cell.attrs.id;
    if (positions.has(key)) return positions.get(key);
    const geometry = child(cell, "mxGeometry");
    let x = Number(geometry?.attrs.x) || 0;
    let y = Number(geometry?.attrs.y) || 0;
    const parent = byId.get(cell.attrs.parent);
    if (parent && parent.attrs.vertex === "1" && depth < 32) {
      const base = absolute(parent, depth + 1);
      x += base.x;
      y += base.y;
    }
    const result = { x, y };
    positions.set(key, result);
    return result;
  };

  const rectOf = cell => {
    const geometry = child(cell, "mxGeometry");
    const { x, y } = absolute(cell);
    return { x, y, w: Number(geometry?.attrs.width) || 0, h: Number(geometry?.attrs.height) || 0 };
  };
  const center = rect => [rect.x + rect.w / 2, rect.y + rect.h / 2];
  const pointOf = node => (node ? [Number(node.attrs.x) || 0, Number(node.attrs.y) || 0] : undefined);

  const boundary = (rect, toward, style, prefix) => {
    const fractionX = Number(style.get(`${prefix}X`));
    const fractionY = Number(style.get(`${prefix}Y`));
    if (Number.isFinite(fractionX) && Number.isFinite(fractionY)) {
      return [rect.x + rect.w * fractionX, rect.y + rect.h * fractionY];
    }
    const [cx, cy] = center(rect);
    const dx = toward[0] - cx;
    const dy = toward[1] - cy;
    if (!dx && !dy) return [cx, cy];
    const scaleX = dx ? (rect.w / 2) / Math.abs(dx) : Infinity;
    const scaleY = dy ? (rect.h / 2) / Math.abs(dy) : Infinity;
    const scale = Math.min(scaleX, scaleY);
    return [cx + dx * scale, cy + dy * scale];
  };

  const nodes = [];
  for (const cell of cells) {
    if (cell.attrs.vertex !== "1") continue;
    const style = styleOf(cell);
    if (style.get("visible") === "0") continue;
    const rect = rectOf(cell);
    if (rect.w <= 0 || rect.h <= 0) continue;
    const label = plainLabel(cell.attrs.value);
    const fontSize = Number(style.get("fontSize")) || 12;
    const shape = style.get("shape");
    const kind = shape === "ellipse" || style.get("ellipse") === "1" ? "ellipse"
      : style.get("rounded") === "1" ? "roundRect" : "rect";
    const bare = shape === "text" || style.has("group");
    nodes.push({
      kind: shape === "text" ? "text" : kind,
      ...rect,
      fill: paintOf(style, "fillColor", bare ? undefined : "#FFFFFF"),
      stroke: paintOf(style, "strokeColor", bare ? undefined : "#000000"),
      strokeWidth: Number(style.get("strokeWidth")) || 1,
      dashed: style.get("dashed") === "1",
      fontSize,
      color: paintOf(style, "fontColor", "#000000"),
      align: alignOf(style.get("align")),
      lines: label ? wrapText(label, fontSize, Math.max(8, rect.w - 10)) : [],
    });
  }

  const edges = [];
  for (const cell of cells) {
    if (cell.attrs.edge !== "1") continue;
    const style = styleOf(cell);
    if (style.get("visible") === "0") continue;
    const geometry = child(cell, "mxGeometry");
    const eachPoint = node => children(node, "mxPoint").map(pointOf).filter(Boolean);
    const waypoints = children(geometry, "Array")
      .filter(item => item.attrs.as === "points")
      .flatMap(eachPoint);
    const pointNodes = children(geometry, "mxPoint");
    const sourcePoint = pointNodes.find(item => item.attrs.as === "sourcePoint");
    const targetPoint = pointNodes.find(item => item.attrs.as === "targetPoint");
    const source = byId.get(cell.attrs.source);
    const target = byId.get(cell.attrs.target);
    const sourceRect = source && source.attrs.vertex === "1" ? rectOf(source) : undefined;
    const targetRect = target && target.attrs.vertex === "1" ? rectOf(target) : undefined;
    const sourceGoal = waypoints[0] ?? (targetRect ? center(targetRect) : pointOf(targetPoint));
    const targetGoal = waypoints[waypoints.length - 1] ?? (sourceRect ? center(sourceRect) : pointOf(sourcePoint));
    const start = sourceRect && sourceGoal ? boundary(sourceRect, sourceGoal, style, "exit") : pointOf(sourcePoint) ?? sourceGoal;
    const end = targetRect && targetGoal ? boundary(targetRect, targetGoal, style, "entry") : pointOf(targetPoint) ?? targetGoal;
    if (!start || !end) continue;
    let points = [start, ...waypoints, end];
    if (waypoints.length === 0 && String(style.get("edgeStyle") || "").includes("orthogonal")) {
      const [x1, y1] = start;
      const [x2, y2] = end;
      points = Math.abs(x2 - x1) >= Math.abs(y2 - y1)
        ? [[x1, y1], [(x1 + x2) / 2, y1], [(x1 + x2) / 2, y2], [x2, y2]]
        : [[x1, y1], [x1, (y1 + y2) / 2], [x2, (y1 + y2) / 2], [x2, y2]];
    }
    const label = plainLabel(cell.attrs.value);
    edges.push({
      points,
      stroke: paintOf(style, "strokeColor", "#000000"),
      strokeWidth: Number(style.get("strokeWidth")) || 1,
      dashed: style.get("dashed") === "1",
      arrow: style.get("endArrow") !== "none",
      ...(label ? { label } : {}),
    });
  }

  const xs = [];
  const ys = [];
  for (const node of nodes) { xs.push(node.x, node.x + node.w); ys.push(node.y, node.y + node.h); }
  for (const edge of edges) for (const [x, y] of edge.points) { xs.push(x); ys.push(y); }
  const pad = 24;
  const minX = xs.length ? Math.min(...xs) - pad : 0;
  const minY = ys.length ? Math.min(...ys) - pad : 0;
  const width = xs.length ? Math.max(...xs) + pad - minX : 480;
  const height = ys.length ? Math.max(...ys) + pad - minY : 320;
  return { name, view: { x: minX, y: minY, width, height }, nodes, edges };
}

function pagesFromXml(xml) {
  const doc = parseXml(xml);
  const diagrams = findAll(doc, "diagram");
  if (!diagrams.length) {
    const model = findAll(doc, "mxGraphModel")[0];
    if (!model) throw new Error("不是 draw.io 图形文件");
    return [pageOf(model, "")];
  }
  return diagrams.map((diagram, index) => {
    const inline = child(diagram, "mxGraphModel") ?? findAll(diagram, "mxGraphModel")[0];
    const name = diagram.attrs.name || `页面 ${index + 1}`;
    return pageOf(inline ?? parseXml(inflatePage(diagram.text)), name);
  });
}

/** Read a .drawio / .drawio.svg file's text into a diagram model. */
function readDrawio(text) {
  const xml = extractXml(text);
  if (!xml) throw new Error("不是 draw.io 图形文件");
  const pages = pagesFromXml(xml);
  if (!pages.length) throw new Error("draw.io 文件中没有图形");
  return { kind: "diagram", pages };
}

/** Read the XML draw.io embeds in a .drawio.png preview image. */
function readDrawioPng(buffer) {
  const xml = embeddedXml(buffer);
  if (!xml) throw new Error("PNG 中没有内嵌 draw.io 图形");
  const pages = pagesFromXml(extractXml(xml) ?? xml);
  if (!pages.length) throw new Error("draw.io 文件中没有图形");
  return { kind: "diagram", pages };
}

module.exports = { readDrawio, readDrawioPng, plainLabel, embeddedXml };
