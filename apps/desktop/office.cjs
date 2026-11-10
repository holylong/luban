const { openZip } = require("./zip.cjs");
const { parseXml, child, children, findAll, textOf } = require("./xml.cjs");
const { wrapText } = require("./text-wrap.cjs");

// OOXML measures in EMU; the preview renders in CSS pixels at 96 dpi.
const EMU_PER_PX = 9525;
const DEFAULT_SLIDE = { cx: 12192000, cy: 6858000 };
// Only images a Chromium renderer can paint are exposed to the preview.
const IMAGE_TYPES = new Map([
  [".png", "image/png"], [".jpg", "image/jpeg"], [".jpeg", "image/jpeg"],
  [".gif", "image/gif"], [".svg", "image/svg+xml"], [".webp", "image/webp"], [".bmp", "image/bmp"],
]);
const FALLBACK_COLORS = new Map([
  ["dk1", "#000000"], ["lt1", "#FFFFFF"], ["dk2", "#44546A"], ["lt2", "#E7E6E6"],
  ["accent1", "#4472C4"], ["accent2", "#ED7D31"], ["accent3", "#A5A5A5"], ["accent4", "#FFC000"],
  ["accent5", "#5B9BD5"], ["accent6", "#70AD47"], ["hlink", "#0563C1"], ["folHlink", "#954F72"],
]);
// DrawingML exposes the first two theme slots as tx1/bg1 instead of dk1/lt1.
const SCHEME_ALIAS = { tx1: "dk1", bg1: "lt1", tx2: "dk2", bg2: "lt2" };

const hexOf = value => {
  if (typeof value !== "string") return undefined;
  const clean = value.trim().replace(/^#/, "");
  return /^[0-9a-fA-F]{6}$/.test(clean) ? `#${clean.toUpperCase()}` : undefined;
};
const number = (node, name, fallback = 0) => {
  const value = Number(node?.attrs?.[name]);
  return Number.isFinite(value) ? value : fallback;
};

function themeColors(zip) {
  const colors = new Map(FALLBACK_COLORS);
  const text = zip.text("ppt/theme/theme1.xml");
  if (!text) return colors;
  const scheme = findAll(parseXml(text), "a:clrScheme")[0];
  for (const slot of scheme?.children ?? []) {
    const hex = slot.children.map(item => hexOf(item.attrs.lastClr) || hexOf(item.attrs.val)).find(Boolean);
    if (hex) colors.set(slot.name.replace(/^a:/, ""), hex);
  }
  return colors;
}

function colorOf(container, colors) {
  const solid = child(container, "a:solidFill");
  if (!solid) return undefined;
  const srgb = child(solid, "a:srgbClr");
  if (srgb) return hexOf(srgb.attrs.val);
  const scheme = child(solid, "a:schemeClr");
  const name = scheme?.attrs.val;
  if (!name) return undefined;
  return colors.get(name) || colors.get(SCHEME_ALIAS[name]);
}

function strokeOf(spPr, colors) {
  const line = child(spPr, "a:ln");
  if (!line) return {};
  const color = colorOf(line, colors);
  if (!color) return {};
  return { stroke: color, strokeWidth: Math.max(0.75, number(line, "w", 12700) / EMU_PER_PX) };
}

function presetKind(spPr) {
  const preset = child(spPr, "a:prstGeom")?.attrs.prst;
  if (preset === "ellipse") return "ellipse";
  if (preset === "roundRect") return "roundRect";
  return "rect";
}

function relsOf(zip, partPath) {
  const parts = partPath.split("/");
  const base = parts[parts.length - 1];
  const directory = parts.slice(0, -1).join("/");
  const text = zip.text(`${directory}/_rels/${base}.rels`);
  const rels = new Map();
  if (!text) return rels;
  for (const rel of findAll(parseXml(text), "Relationship")) {
    const id = rel.attrs.Id;
    const target = rel.attrs.Target;
    if (!id || !target) continue;
    rels.set(id, { target: resolvePart(directory, target), type: rel.attrs.Type || "", external: rel.attrs.TargetMode === "External" });
  }
  return rels;
}

function resolvePart(directory, target) {
  if (target.startsWith("/")) return target.slice(1);
  const parts = directory.split("/").filter(Boolean);
  for (const piece of target.split("/")) {
    if (piece === "..") parts.pop();
    else if (piece && piece !== ".") parts.push(piece);
  }
  return parts.join("/");
}

/** Wrap and place text lines inside a shape box, honouring insets and anchoring. */
function layoutText(paragraphs, box, bodyPr) {
  const inset = name => number(bodyPr, name, name === "lIns" || name === "rIns" ? 91440 : 45720) / EMU_PER_PX;
  const left = box.x + inset("lIns");
  const top = box.y + inset("tIns");
  const right = box.x + box.w - inset("rIns");
  const bottom = box.y + box.h - inset("bIns");
  const width = Math.max(1, right - left);
  const limit = bottom - top;
  const placed = [];
  for (const paragraph of paragraphs) {
    if (!paragraph.text.trim()) continue;
    const size = paragraph.size;
    const indent = paragraph.bullet ? size : 0;
    const wrapped = wrapText(paragraph.text, size, Math.max(1, width - indent));
    for (let index = 0; index < wrapped.length; index++) {
      const line = wrapped[index];
      if (!line) continue;
      const x = paragraph.align === "center" ? left + indent / 2 + (width - indent) / 2
        : paragraph.align === "right" ? right : left + indent;
      placed.push({
        text: index === 0 && paragraph.bullet ? `${paragraph.bullet} ${line}` : line,
        x, size, align: paragraph.align,
        bold: paragraph.bold, italic: paragraph.italic, color: paragraph.color,
        height: Math.max(size * 1.2, 4),
      });
    }
  }
  const total = placed.reduce((sum, line) => sum + line.height, 0);
  const anchor = bodyPr?.attrs?.anchor;
  let cursor = top;
  if (total <= limit && anchor === "ctr") cursor = top + (limit - total) / 2;
  else if (total <= limit && anchor === "b") cursor = top + limit - total;
  cursor = Math.max(cursor, top);
  for (const line of placed) {
    line.y = cursor + line.size;
    cursor += line.height;
  }
  return placed.filter(line => line.y - line.size <= bottom + line.height);
}

function alignOf(value) {
  if (value === "ctr") return "center";
  if (value === "r" || value === "right") return "right";
  return "left";
}

function placeholderType(node) {
  return findAll(node, "p:ph")[0]?.attrs.type;
}

function defaultPointSize(node) {
  const type = placeholderType(node);
  if (type === "title" || type === "ctrTitle") return 32;
  if (type === "subTitle") return 20;
  return 18;
}

function paragraphOf(node, colors) {
  const pPr = child(node, "a:pPr");
  const defRPr = child(pPr, "a:defRPr");
  let text = "";
  let size = 0;
  let bold = false;
  let italic = false;
  let color;
  for (const item of node.children) {
    if (item.name !== "a:r" && item.name !== "a:fld") continue;
    const rPr = child(item, "a:rPr");
    const piece = child(item, "a:t")?.text ?? "";
    if (piece && !text) {
      size = number(rPr, "sz") || number(defRPr, "sz");
      bold = rPr?.attrs?.b === "1";
      italic = rPr?.attrs?.i === "1";
      color = colorOf(rPr, colors);
    }
    text += piece;
  }
  const bulletNode = child(pPr, "a:buChar");
  const bullet = bulletNode?.attrs?.char || (child(pPr, "a:buAutoNum") ? "•" : "");
  return {
    text, align: alignOf(pPr?.attrs?.algn), bullet: child(pPr, "a:buNone") ? "" : bullet,
    size: size ? size / 75 : 0, bold, italic, color,
  };
}

function textParagraphs(node, colors, fallbackPoints, extra = false) {
  const body = child(node, "p:txBody");
  if (!body && !extra) return null;
  const bodyPr = child(body, "a:bodyPr");
  const source = body ? children(body, "a:p") : findAll(node, "a:p");
  const paragraphs = source.map(item => paragraphOf(item, colors))
    .map(item => ({ ...item, size: item.size || fallbackPoints * (4 / 3) }))
    .filter(item => item.text.trim());
  return { paragraphs, bodyPr };
}

function geometryOf(node) {
  const xfrm = node.name === "p:graphicFrame" ? child(node, "p:xfrm") : child(child(node, "p:spPr"), "a:xfrm");
  if (!xfrm) return undefined;
  const off = child(xfrm, "a:off");
  const ext = child(xfrm, "a:ext");
  return {
    x: number(off, "x"), y: number(off, "y"), w: number(ext, "cx"), h: number(ext, "cy"),
    rotation: number(xfrm, "rot") / 60000,
    flipH: xfrm.attrs?.flipH === "1", flipV: xfrm.attrs?.flipV === "1",
  };
}

function groupTransform(node) {
  const xfrm = child(child(node, "p:grpSpPr"), "a:xfrm");
  const off = child(xfrm, "a:off");
  const ext = child(xfrm, "a:ext");
  const chOff = child(xfrm, "a:chOff");
  const chExt = child(xfrm, "a:chExt");
  const scaleX = number(chExt, "cx") ? number(ext, "cx") / number(chExt, "cx") : 1;
  const scaleY = number(chExt, "cy") ? number(ext, "cy") / number(chExt, "cy") : 1;
  const originX = number(off, "x");
  const originY = number(off, "y");
  const childX = number(chOff, "x");
  const childY = number(chOff, "y");
  return (x, y) => [originX + (x - childX) * scaleX, originY + (y - childY) * scaleY];
}

function mapBox(geometry, transform) {
  const [x1, y1] = transform(geometry.x, geometry.y);
  const [x2, y2] = transform(geometry.x + geometry.w, geometry.y + geometry.h);
  return {
    x: Math.min(x1, x2) / EMU_PER_PX, y: Math.min(y1, y2) / EMU_PER_PX,
    w: Math.abs(x2 - x1) / EMU_PER_PX, h: Math.abs(y2 - y1) / EMU_PER_PX,
  };
}

function slideShapes(tree, slideRels, colors) {
  const shapes = [];

  function walk(node, transform) {
    for (const item of node.children) {
      if (item.name === "p:grpSp") {
        const local = groupTransform(item);
        walk(item, (x, y) => { const [gx, gy] = local(x, y); return transform(gx, gy); });
        continue;
      }
      if (item.name !== "p:sp" && item.name !== "p:pic" && item.name !== "p:cxnSp" && item.name !== "p:graphicFrame") continue;
      const shape = shapeOf(item, transform, slideRels, colors);
      if (shape) shapes.push(shape);
    }
  }

  walk(tree, (x, y) => [x, y]);
  return shapes;
}

function shapeOf(node, transform, slideRels, colors) {
  const geometry = geometryOf(node);
  if (!geometry || (!geometry.w && !geometry.h)) return undefined;
  const box = mapBox(geometry, transform);
  if (box.w <= 0 || box.h <= 0) return undefined;
  const base = { x: box.x, y: box.y, w: box.w, h: box.h };

  if (node.name === "p:pic") {
    const blip = findAll(node, "a:blip")[0];
    const rel = blip?.attrs?.["r:embed"] ? slideRels.get(blip.attrs["r:embed"]) : undefined;
    if (!rel || rel.external) return undefined;
    const extension = rel.target.slice(rel.target.lastIndexOf(".")).toLowerCase();
    if (!IMAGE_TYPES.has(extension)) return undefined;
    return { kind: "image", ...base, image: rel.target, rotation: geometry.rotation };
  }

  if (node.name === "p:cxnSp") {
    const spPr = child(node, "p:spPr");
    return { kind: "line", ...base, rotation: geometry.rotation, flipH: geometry.flipH, flipV: geometry.flipV, ...strokeOf(spPr, colors) };
  }

  const spPr = child(node, "p:spPr");
  const fill = colorOf(spPr, colors);
  const stroke = strokeOf(spPr, colors);
  const text = textParagraphs(node, colors, defaultPointSize(node), node.name === "p:graphicFrame");
  const lines = text ? layoutText(text.paragraphs, base, text.bodyPr) : [];
  const rotation = geometry.rotation;
  if (node.name === "p:graphicFrame") {
    if (!lines.length) return undefined;
    return { kind: "rect", ...base, fill: fill ?? "transparent", rotation, lines };
  }
  const filled = fill || stroke.stroke;
  if (!filled && !lines.length) return undefined;
  return { kind: presetKind(spPr), ...base, fill, ...stroke, rotation, lines };
}

function notesOf(zip, slidePath, slideRels) {
  const rel = [...slideRels.values()].find(item => item.type.endsWith("/notesSlide") && !item.external);
  if (!rel) return "";
  const xml = zip.text(rel.target);
  if (!xml) return "";
  const doc = parseXml(xml);
  return findAll(doc, "a:p")
    .map(paragraph => children(paragraph, "a:r").map(run => textOf(run)).join("").trim())
    .filter(Boolean).join("\n");
}

function backgroundShapes(doc, colors, width, height) {
  const background = findAll(doc, "p:bg")[0];
  const fill = background ? colorOf(child(background, "p:bgPr"), colors) : undefined;
  return fill ? [{ kind: "rect", x: 0, y: 0, w: width, h: height, fill }] : [];
}

function sortedSlides(zip) {
  return zip.list()
    .filter(name => /^ppt\/slides\/[^/]+\.xml$/.test(name))
    .sort((a, b) => (Number(/(\d+)\.xml$/.exec(a)?.[1]) || 0) - (Number(/(\d+)\.xml$/.exec(b)?.[1]) || 0));
}

/** Read a .pptx package into a slide model for the desktop renderer. */
function readPptx(buffer) {
  const zip = openZip(buffer);
  const presentationXml = zip.text("ppt/presentation.xml");
  if (!presentationXml) throw new Error("不是有效的 PPTX 文件");
  const presentation = parseXml(presentationXml);
  const size = findAll(presentation, "p:sldSz")[0]?.attrs ?? {};
  const width = (Number(size.cx) || DEFAULT_SLIDE.cx) / EMU_PER_PX;
  const height = (Number(size.cy) || DEFAULT_SLIDE.cy) / EMU_PER_PX;
  const colors = themeColors(zip);
  const rels = relsOf(zip, "ppt/presentation.xml");
  const slidePaths = [];
  for (const id of findAll(presentation, "p:sldId")) {
    const rel = rels.get(id.attrs["r:id"]);
    if (rel && !rel.external && zip.has(rel.target)) slidePaths.push(rel.target);
  }
  if (!slidePaths.length) slidePaths.push(...sortedSlides(zip));
  if (!slidePaths.length) throw new Error("PPTX 中没有幻灯片");

  const slides = slidePaths.map((path, index) => {
    const xml = zip.text(path) ?? "";
    const doc = parseXml(xml);
    const slideRels = relsOf(zip, path);
    const shapes = backgroundShapes(doc, colors, width, height);
    const tree = findAll(doc, "p:spTree")[0];
    if (tree) shapes.push(...slideShapes(tree, slideRels, colors));
    const notes = notesOf(zip, path, slideRels);
    return { index: index + 1, shapes, ...(notes ? { notes } : {}) };
  });
  return { kind: "slides", width: Math.round(width * 100) / 100, height: Math.round(height * 100) / 100, slides };
}

module.exports = { readPptx };
