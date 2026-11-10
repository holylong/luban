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


// ---------------------------------------------------------------------------
// Spreadsheets and word processing documents.
//
// Elements are matched by local name: exporters disagree about prefixes (WPS
// writes XLSX parts with a default namespace, Word writes w:p), and a preview
// only needs element names, attributes and text.

const MAX_SHEET_ROWS = 400;
const MAX_SHEET_COLUMNS = 50;
const MAX_SHEETS = 20;
const MAX_WORD_BLOCKS = 4000;
const DATE_FORMAT_IDS = new Set([14, 15, 16, 17, 18, 19, 20, 21, 22, 45, 46, 47, 27, 28, 29, 30, 31, 32, 33, 34, 35, 36, 50, 51, 52, 53, 54, 55, 56, 57, 58]);

const local = name => String(name ?? "").split(":").pop();
const byLocal = (node, name) => node?.children.find(item => local(item.name) === name);
const allLocal = (node, name) => node?.children.filter(item => local(item.name) === name) ?? [];

function findAllLocal(node, name, found = []) {
  if (!node) return found;
  for (const item of node.children) {
    if (local(item.name) === name) found.push(item);
    findAllLocal(item, name, found);
  }
  return found;
}

function attr(node, name) {
  if (!node) return undefined;
  if (node.attrs[name] !== undefined) return node.attrs[name];
  for (const [key, value] of Object.entries(node.attrs)) if (local(key) === name) return value;
  return undefined;
}

/** "AB12" -> 27, the zero-based column index of a cell reference. */
function columnOfRef(ref) {
  let column = 0;
  for (const character of String(ref ?? "")) {
    const code = character.charCodeAt(0);
    if (code < 65 || code > 90) break;
    column = column * 26 + (code - 64);
  }
  return Math.max(0, column - 1);
}

const prettyNumber = value => {
  if (!Number.isFinite(value)) return "";
  if (Number.isInteger(value)) return String(value);
  return String(Number(value.toPrecision(12)));
};

/** Excel stores dates as days since an epoch; the workbook picks which one. */
function excelDate(value, date1904) {
  if (!Number.isFinite(value) || value < 0) return undefined;
  if (value < 1) {
    const minutes = Math.round(value * 24 * 60);
    return `${String(Math.floor(minutes / 60)).padStart(2, "0")}:${String(minutes % 60).padStart(2, "0")}`;
  }
  const base = date1904 ? Date.UTC(1904, 0, 1) : Date.UTC(1899, 11, 30);
  const date = new Date(base + Math.floor(value) * 86400000);
  const pad = input => String(input).padStart(2, "0");
  const day = `${date.getUTCFullYear()}-${pad(date.getUTCMonth() + 1)}-${pad(date.getUTCDate())}`;
  const minutes = Math.round((value % 1) * 24 * 60);
  return minutes ? `${day} ${pad(Math.floor(minutes / 60))}:${pad(minutes % 60)}` : day;
}

function sharedStringsOf(zip) {
  const text = zip.text("xl/sharedStrings.xml");
  if (!text) return [];
  return findAllLocal(parseXml(text), "si").map(node => findAllLocal(node, "t").map(item => item.text).join(""));
}

/** Cell-style indexes whose number format renders a date. */
function dateStyleIndexes(zip) {
  const indexes = new Set();
  const text = zip.text("xl/styles.xml");
  if (!text) return indexes;
  const doc = parseXml(text);
  const formats = new Set(DATE_FORMAT_IDS);
  for (const format of findAllLocal(doc, "numFmt")) {
    const id = Number(attr(format, "numFmtId"));
    const code = String(attr(format, "formatCode") ?? "")
      .replace(/"[^"]*"/g, "").replace(/\\./g, "").replace(/\[[^\]]*\]/g, "").toLowerCase();
    if (/[ymdhs]/.test(code) && Number.isFinite(id)) formats.add(id);
  }
  const styles = allLocal(findAllLocal(doc, "cellXfs")[0], "xf");
  styles.forEach((style, index) => { if (formats.has(Number(attr(style, "numFmtId")))) indexes.add(index); });
  return indexes;
}

function sheetCell(node, shared, dateStyles, date1904) {
  const type = attr(node, "t");
  const style = Number(attr(node, "s"));
  const raw = byLocal(node, "v")?.text ?? "";
  if (type === "s") {
    const text = shared[Number(raw)] ?? "";
    return text ? { text } : null;
  }
  if (type === "inlineStr") {
    const text = findAllLocal(byLocal(node, "is") ?? node, "t").map(item => item.text).join("");
    return text ? { text } : null;
  }
  if (type === "str" || type === "d") return raw ? { text: raw } : null;
  if (type === "b") return { text: raw === "1" ? "TRUE" : "FALSE" };
  if (type === "e") return raw ? { text: raw } : null;
  if (!raw) return null;
  const value = Number(raw);
  if (!Number.isFinite(value)) return { text: raw };
  const date = dateStyles.has(style) ? excelDate(value, date1904) : undefined;
  return date ? { text: date } : { text: prettyNumber(value), numeric: true };
}

function sheetRowsOf(xml, shared, dateStyles, date1904) {
  const doc = parseXml(xml);
  const data = findAllLocal(doc, "sheetData")[0];
  const rows = [];
  let columns = 0;
  let truncatedRows = 0;
  let truncatedColumns = 0;
  let expected = 1;
  for (const rowNode of allLocal(data, "row")) {
    const index = Number(attr(rowNode, "r")) || expected;
    expected = index + 1;
    const cells = [];
    let filled = false;
    for (const cellNode of allLocal(rowNode, "c")) {
      const column = columnOfRef(attr(cellNode, "r")) ;
      const cell = sheetCell(cellNode, shared, dateStyles, date1904);
      if (column >= MAX_SHEET_COLUMNS) { if (cell) truncatedColumns += 1; continue; }
      while (cells.length < column) cells.push(null);
      cells[column] = cell;
      if (cell) filled = true;
    }
    while (cells.length && !cells[cells.length - 1]) cells.pop();
    if (!filled && !cells.length) continue;
    columns = Math.max(columns, cells.length);
    if (rows.length >= MAX_SHEET_ROWS) { truncatedRows += 1; continue; }
    rows.push({ index, cells });
  }
  const trim = input => input ? input : undefined;
  return { name: "", columns, rows, truncatedRows: trim(truncatedRows), truncatedColumns: trim(truncatedColumns) };
}

/** Read a .xlsx package into a grid model for the desktop renderer. */
function readXlsx(buffer) {
  const zip = openZip(buffer);
  const workbookXml = zip.text("xl/workbook.xml");
  if (!workbookXml) throw new Error("不是有效的 XLSX 文件");
  const workbook = parseXml(workbookXml);
  const date1904 = /^(1|true)$/i.test(String(attr(findAllLocal(workbook, "workbookPr")[0], "date1904") ?? ""));
  const rels = relsOf(zip, "xl/workbook.xml");
  const shared = sharedStringsOf(zip);
  const dateStyles = dateStyleIndexes(zip);
  const nodes = findAllLocal(workbook, "sheet").slice(0, MAX_SHEETS);
  if (!nodes.length) throw new Error("工作簿中没有工作表");
  const sheets = nodes.map((node, position) => {
    const rel = rels.get(attr(node, "r:id") ?? attr(node, "id"));
    const path = rel && !rel.external && zip.has(rel.target) ? rel.target : `xl/worksheets/sheet${position + 1}.xml`;
    const name = attr(node, "name") || `Sheet${position + 1}`;
    const xml = zip.text(path);
    return { ...(xml ? sheetRowsOf(xml, shared, dateStyles, date1904) : { columns: 0, rows: [], truncatedRows: undefined, truncatedColumns: undefined }), name };
  });
  return { kind: "sheet", sheets };
}

/** Word style id -> display name, so headings are recognised by their name. */
function wordStyleNames(zip) {
  const names = new Map();
  const text = zip.text("word/styles.xml");
  if (!text) return names;
  for (const style of findAllLocal(parseXml(text), "style")) {
    const id = attr(style, "styleId");
    if (id) names.set(id, attr(byLocal(style, "name"), "val") || id);
  }
  return names;
}

/** numId -> bullet or ordered, from the numbering definitions. */
function wordNumbering(zip) {
  const numbers = new Map();
  const text = zip.text("word/numbering.xml");
  if (!text) return numbers;
  const doc = parseXml(text);
  const abstracts = new Map();
  for (const abstract of findAllLocal(doc, "abstractNum")) {
    const format = attr(byLocal(findAllLocal(abstract, "lvl")[0], "numFmt"), "val") || "bullet";
    abstracts.set(attr(abstract, "abstractNumId"), /decimal|letter|roman|ordinal|cardinal/i.test(format) ? "ordered" : "bullet");
  }
  for (const number of findAllLocal(doc, "num")) {
    const abstractId = attr(byLocal(number, "abstractNumId"), "val");
    numbers.set(attr(number, "numId"), abstracts.get(abstractId) ?? "bullet");
  }
  return numbers;
}

function wordText(node) {
  let text = "";
  for (const item of node.children) {
    const name = local(item.name);
    if (name === "t") text += item.text;
    else if (name === "tab") text += "\t";
    else if (name === "br" || name === "cr") text += "\n";
    else if (name === "delText" || name === "instrText" || name === "rPr" || name === "pPr") continue;
    else if (item.children.length) text += wordText(item);
  }
  return text;
}

function wordParagraph(node, styles, numbering) {
  const properties = byLocal(node, "pPr");
  const styleId = attr(byLocal(properties, "pStyle"), "val");
  const styleName = styleId ? styles.get(styleId) ?? styleId : "";
  const heading = /(?:heading|标题)\s*([1-6])/i.exec(styleName) ?? /^([1-6])$/.exec(styleName);
  const title = /^title$|^标题$/i.test(styleName);
  const numPr = byLocal(properties, "numPr");
  const ordered = numPr ? (numbering.get(attr(byLocal(numPr, "numId"), "val") ?? "") ?? "bullet") !== "bullet" : undefined;
  return {
    text: wordText(node).replace(/[ \t]+\n/g, "\n").trim(),
    level: heading ? Number(heading[1]) : title ? 1 : undefined,
    list: Boolean(numPr),
    ordered,
  };
}

function wordTable(node, styles, numbering) {
  return allLocal(node, "tr").map(row => allLocal(row, "tc").map(cell =>
    allLocal(cell, "p").map(paragraph => wordParagraph(paragraph, styles, numbering).text).filter(Boolean).join("\n")));
}

/** Body children in document order: paragraphs, heading runs, lists and tables. */
function wordBlocks(node, styles, numbering) {
  const blocks = [];
  let list;
  const flush = () => { if (list) { blocks.push(list); list = undefined; } };
  for (const item of node?.children ?? []) {
    const name = local(item.name);
    if (name === "p") {
      const paragraph = wordParagraph(item, styles, numbering);
      if (!paragraph.text) { flush(); continue; }
      if (paragraph.list) {
        if (!list || list.ordered !== paragraph.ordered) { flush(); list = { type: "list", ordered: paragraph.ordered, items: [] }; }
        list.items.push(paragraph.text);
        continue;
      }
      flush();
      blocks.push(paragraph.level ? { type: "heading", level: paragraph.level, text: paragraph.text } : { type: "paragraph", text: paragraph.text });
      continue;
    }
    if (name === "tbl") { flush(); blocks.push({ type: "table", rows: wordTable(item, styles, numbering) }); continue; }
    if (name === "sdt" || name === "sdtContent" || name === "customXml" || name === "body") {
      flush();
      blocks.push(...wordBlocks(item, styles, numbering));
      continue;
    }
  }
  flush();
  return blocks.slice(0, MAX_WORD_BLOCKS);
}

/** Read a .docx package into a block model for the desktop renderer. */
function readDocx(buffer) {
  const zip = openZip(buffer);
  const xml = zip.text("word/document.xml");
  if (!xml) throw new Error("不是有效的 DOCX 文件");
  const body = findAllLocal(parseXml(xml), "body")[0];
  if (!body) throw new Error("DOCX 中没有正文");
  const blocks = wordBlocks(body, wordStyleNames(zip), wordNumbering(zip));
  if (!blocks.length) throw new Error("文档没有可显示的文本");
  return { kind: "word", blocks };
}

module.exports = { readPptx, readXlsx, readDocx };
