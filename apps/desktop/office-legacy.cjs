// Legacy Office previews: Word 97-2003 (.doc) text and Excel 97-2003 (.xls)
// grids. Both are compound files, so the bytes come from ole.cjs and the modes
// below only decode the streams those documents are required to carry.
//
// The preview is deliberately text-level: character and cell formatting is not
// reproduced, because a reader that renders the words is more useful than one
// that guesses at fonts.

const { readCompound } = require("./ole.cjs");

const MAX_ROWS = 400;
const MAX_COLUMNS = 50;
const MAX_SHEETS = 20;
const MAX_PARAGRAPHS = 4000;

// cp1252 differs from latin1 exactly in this range; Word compresses text to it.
const CP1252 = new Map([
  [0x80, "\u20ac"], [0x82, "\u201a"], [0x83, "\u0192"], [0x84, "\u201e"], [0x85, "\u2026"],
  [0x86, "\u2020"], [0x87, "\u2021"], [0x88, "\u02c6"], [0x89, "\u2030"], [0x8a, "\u0160"],
  [0x8b, "\u2039"], [0x8c, "\u0152"], [0x8e, "\u017d"], [0x91, "\u2018"], [0x92, "\u2019"],
  [0x93, "\u201c"], [0x94, "\u201d"], [0x95, "\u2022"], [0x96, "\u2013"], [0x97, "\u2014"],
  [0x98, "\u02dc"], [0x99, "\u2122"], [0x9a, "\u0161"], [0x9b, "\u203a"], [0x9c, "\u0153"],
  [0x9e, "\u017e"], [0x9f, "\u0178"],
]);

const decodeCp1252 = bytes => {
  let text = "";
  for (const byte of bytes) text += CP1252.get(byte) ?? String.fromCharCode(byte);
  return text;
};

// ---------------------------------------------------------------------------
// Word 97-2003 (.doc)

/** Remove field instructions, keep field results, turn Word's marks into text. */
function cleanWordText(source) {
  let text = "";
  let fields = 0;
  let instruction = 0;
  for (let index = 0; index < source.length; index++) {
    const code = source.charCodeAt(index);
    if (code === 0x13) { fields += 1; instruction += 1; continue; }
    if (code === 0x14) { if (instruction > 0) instruction -= 1; continue; }
    if (code === 0x15) { if (fields > 0) fields -= 1; instruction = 0; continue; }
    if (instruction > 0) continue;
    if (code === 0x0d || code === 0x0b || code === 0x0c || code === 0x0e || code === 0x07) { text += "\n"; continue; }
    if (code === 0x09) { text += "\t"; continue; }
    if (code === 0x1e) { text += "-"; continue; }
    if (code === 0x1f) continue;
    if (code === 0xa0) { text += " "; continue; }
    if (code < 0x20) continue;
    text += source[index];
  }
  return text;
}

function wordPieces(textStream, table, fcClx, lcbClx) {
  if (!table || lcbClx <= 0 || fcClx < 0 || fcClx + lcbClx > table.length) {
    throw new Error("Word 文档缺少文本索引");
  }
  let position = fcClx;
  // Optional property blocks precede the piece table.
  while (table[position] === 0x01) {
    const size = table.readUInt16LE(position + 1);
    position += 3 + size;
  }
  if (table[position] !== 0x02) throw new Error("Word 文档的文本索引无法识别");
  const length = table.readUInt32LE(position + 1);
  const tableStart = position + 5;
  if (length < 4 || tableStart + length > table.length) throw new Error("Word 文档的文本索引已损坏");
  const count = (length - 4) / 12;
  if (!Number.isInteger(count) || count <= 0) throw new Error("Word 文档的文本索引已损坏");
  const pcdStart = tableStart + (count + 1) * 4;
  let text = "";
  for (let index = 0; index < count; index++) {
    const from = table.readUInt32LE(tableStart + index * 4);
    const to = table.readUInt32LE(tableStart + (index + 1) * 4);
    const characters = to - from;
    if (characters <= 0) continue;
    const descriptor = pcdStart + index * 8;
    if (descriptor + 8 > tableStart + length) break;
    const raw = table.readUInt32LE(descriptor + 2);
    const compressed = (raw & 0x40000000) !== 0;
    const offset = compressed ? (raw & 0x3fffffff) >>> 1 : raw & 0x3fffffff;
    const bytes = compressed ? characters : characters * 2;
    if (offset + bytes > textStream.length) continue;
    const slice = textStream.subarray(offset, offset + bytes);
    text += compressed ? decodeCp1252(slice) : slice.toString("utf16le");
  }
  return text;
}

/** Extract the paragraphs of a Word 97-2003 document. */
function readDoc(buffer) {
  const compound = readCompound(buffer);
  const word = compound.read("WordDocument");
  if (!word || word.length < 0x1aa) throw new Error("不是有效的 Word 文档");
  if (word.readUInt16LE(0) !== 0xa5ec) throw new Error("不是有效的 Word 文档");
  const version = word.readUInt16LE(2);
  if (version < 0x65) throw new Error("Word 6.0/95 文档无法预览，请用系统应用打开");
  const flags = word.readUInt16LE(0x0a);
  const table = compound.read((flags & 0x0200) !== 0 ? "1Table" : "0Table");
  if (!table) throw new Error("Word 文档缺少表流");
  const fcClx = word.readUInt32LE(0x01a2);
  const lcbClx = word.readUInt32LE(0x01a6);
  const text = cleanWordText(wordPieces(word, table, fcClx, lcbClx));
  const paragraphs = text.split("\n").map(line => line.trim()).filter(Boolean);
  if (!paragraphs.length) throw new Error("文档没有可显示的文本");
  return {
    kind: "word",
    blocks: paragraphs.slice(0, MAX_PARAGRAPHS).map(line => ({ type: "paragraph", text: line.slice(0, 4000) })),
  };
}

// ---------------------------------------------------------------------------
// Excel 97-2003 (.xls)

function recordsOf(stream) {
  const records = [];
  let offset = 0;
  while (offset + 4 <= stream.length) {
    const type = stream.readUInt16LE(offset);
    const length = stream.readUInt16LE(offset + 2);
    const start = offset + 4;
    if (start + length > stream.length) break;
    records.push({ type, data: stream.subarray(start, start + length), offset });
    offset = start + length;
  }
  return records;
}

/** BIFF8 strings can continue into CONTINUE records, which restart with flags. */
function chunkCursor(chunks) {
  let chunk = 0;
  let offset = 0;
  const skipEmpty = () => {
    while (chunk < chunks.length && offset >= chunks[chunk].length) { chunk += 1; offset = 0; }
  };
  const raw = size => {
    const output = Buffer.alloc(size);
    let written = 0;
    while (written < size) {
      skipEmpty();
      if (chunk >= chunks.length) break;
      const take = Math.min(size - written, chunks[chunk].length - offset);
      chunks[chunk].copy(output, written, offset, offset + take);
      offset += take;
      written += take;
    }
    return output.subarray(0, written);
  };
  const u8 = () => (raw(1)[0] ?? 0);
  const u16 = () => { const bytes = raw(2); return bytes.length === 2 ? bytes.readUInt16LE(0) : 0; };
  const u32 = () => { const bytes = raw(4); return bytes.length === 4 ? bytes.readUInt32LE(0) : 0; };
  const chars = (count, high) => {
    let text = "";
    let remaining = count;
    while (remaining > 0) {
      skipEmpty();
      if (chunk >= chunks.length) break;
      const available = Math.floor((chunks[chunk].length - offset) / (high ? 2 : 1));
      if (available === 0) {
        // Character data continues in the next record; its first byte is a new
        // option flags field, not part of the text.
        chunk += 1;
        offset = 0;
        skipEmpty();
        if (chunk >= chunks.length) break;
        high = (chunks[chunk][0] & 1) === 1;
        offset = 1;
        continue;
      }
      const take = Math.min(available, remaining);
      const bytes = take * (high ? 2 : 1);
      text += high
        ? chunks[chunk].toString("utf16le", offset, offset + bytes)
        : decodeCp1252(chunks[chunk].subarray(offset, offset + bytes));
      offset += bytes;
      remaining -= take;
    }
    return text;
  };
  return { raw, u8, u16, u32, chars };
}

function sharedStringsOf(chunks) {
  const cursor = chunkCursor(chunks);
  cursor.u32();
  const unique = cursor.u32();
  const strings = [];
  for (let index = 0; index < unique && index < 200000; index++) {
    const count = cursor.u16();
    const flags = cursor.u8();
    const high = (flags & 0x01) !== 0;
    const rich = (flags & 0x08) !== 0;
    const far = (flags & 0x04) !== 0;
    let runs = 0;
    let extra = 0;
    if (rich) runs = cursor.u16();
    if (far) extra = cursor.u32();
    strings.push(cursor.chars(count, high));
    if (runs) cursor.raw(runs * 4);
    if (extra) cursor.raw(extra);
  }
  return strings;
}

function boundsheetName(data) {
  const count = data[6] ?? 0;
  const flags = data[7] ?? 0;
  const start = 8;
  if ((flags & 1) !== 0) return data.toString("utf16le", start, start + count * 2).replace(/\0.*$/, "");
  return decodeCp1252(data.subarray(start, start + count)).replace(/\0.*$/, "");
}

/** RK numbers pack a small int or a truncated double, optionally /100. */
function rkNumber(rk) {
  const value = (rk & 0x02) !== 0
    ? (rk << 16) >> 18
    : new Float64Array(new Uint32Array([0, rk & 0xfffffffc]).buffer)[0];
  return (rk & 0x01) !== 0 ? value / 100 : value;
}

const prettyNumber = value => {
  if (!Number.isFinite(value)) return "";
  if (Number.isInteger(value)) return String(value);
  return String(Number(value.toPrecision(12)));
};

function sheetOf(records, start, shared) {
  const rows = new Map();
  let columns = 0;
  let truncatedRows = 0;
  let truncatedColumns = 0;
  let formula;
  const put = (row, column, cell) => {
    if (!cell) return;
    if (column >= MAX_COLUMNS) { truncatedColumns += 1; return; }
    let cells = rows.get(row);
    if (!cells) { cells = []; rows.set(row, cells); }
    cells[column] = cell;
    columns = Math.max(columns, column + 1);
  };
  const numberCell = value => Number.isFinite(value) ? { text: prettyNumber(value), numeric: true } : null;
  for (let index = start; index < records.length; index++) {
    const { type, data } = records[index];
    if (type === 0x000a) break;
    if (type === 0x0203 && data.length >= 14) { put(data.readUInt16LE(0), data.readUInt16LE(2), numberCell(data.readDoubleLE(6))); continue; }
    if (type === 0x027e && data.length >= 10) { put(data.readUInt16LE(0), data.readUInt16LE(2), numberCell(rkNumber(data.readUInt32LE(6)))); continue; }
    if (type === 0x00bd && data.length >= 8) {
      const row = data.readUInt16LE(0);
      const first = data.readUInt16LE(2);
      const count = (data.length - 6) / 6;
      for (let item = 0; item < count; item++) {
        put(row, first + item, numberCell(rkNumber(data.readUInt32LE(4 + item * 6 + 2))));
      }
      continue;
    }
    if (type === 0x00fd && data.length >= 10) { put(data.readUInt16LE(0), data.readUInt16LE(2), { text: shared[data.readUInt32LE(6)] ?? "" }); continue; }
    if (type === 0x0204 && data.length >= 8) {
      const count = data.readUInt16LE(6);
      const high = (data[8] & 0x01) !== 0;
      const text = high ? data.toString("utf16le", 9, 9 + count * 2) : decodeCp1252(data.subarray(9, 9 + count));
      if (text) put(data.readUInt16LE(0), data.readUInt16LE(2), { text });
      continue;
    }
    if (type === 0x0205 && data.length >= 8) {
      put(data.readUInt16LE(0), data.readUInt16LE(2), { text: data[7] ? "#ERROR" : data[6] ? "TRUE" : "FALSE" });
      continue;
    }
    if (type === 0x0006 && data.length >= 14) {
      const row = data.readUInt16LE(0);
      const column = data.readUInt16LE(2);
      if (data[12] === 0xff && data[13] === 0xff) {
        const kind = data[6];
        if (kind === 0) { formula = { row, column }; continue; }
        if (kind === 1) { put(row, column, { text: data[8] ? "TRUE" : "FALSE" }); continue; }
        if (kind === 2) { put(row, column, { text: "#ERROR" }); continue; }
        continue;
      }
      put(row, column, numberCell(data.readDoubleLE(6)));
      continue;
    }
    if (type === 0x0207 && formula && data.length >= 3) {
      const count = data.readUInt16LE(0);
      const high = (data[2] & 0x01) !== 0;
      const text = high ? data.toString("utf16le", 3, 3 + count * 2) : decodeCp1252(data.subarray(3, 3 + count));
      put(formula.row, formula.column, text ? { text } : null);
      formula = undefined;
      continue;
    }
  }
  const indexes = [...rows.keys()].sort((a, b) => a - b);
  const visible = [];
  for (const index of indexes) {
    if (visible.length >= MAX_ROWS) { truncatedRows += 1; continue; }
    const cells = rows.get(index);
    while (cells.length && !cells[cells.length - 1]) cells.pop();
    visible.push({ index: index + 1, cells: cells.map(cell => cell ?? null) });
  }
  return { name: "", columns, rows: visible, truncatedRows: truncatedRows || undefined, truncatedColumns: truncatedColumns || undefined };
}

/** Read an .xls workbook into the same grid model as XLSX. */
function readXls(buffer) {
  const compound = readCompound(buffer);
  const stream = compound.read("Workbook") ?? compound.read("Book");
  if (!stream || stream.length < 8) throw new Error("不是有效的 XLS 文件");
  const records = recordsOf(stream);
  if (!records.length || records[0].type !== 0x0809) throw new Error("不是有效的 XLS 文件");
  const sheets = [];
  let shared = [];
  for (let index = 0; index < records.length; index++) {
    const { type, data } = records[index];
    if (type === 0x0085 && data.length >= 8) {
      const position = data.readUInt32LE(0);
      const hidden = (data[4] & 0x03) !== 0;
      sheets.push({ position, name: boundsheetName(data), hidden });
      continue;
    }
    if (type === 0x00fc) {
      const chunks = [data];
      while (records[index + 1]?.type === 0x003c) chunks.push(records[++index].data);
      shared = sharedStringsOf(chunks);
      continue;
    }
    if (type === 0x000a) break;
  }
  const parsed = [];
  for (const sheet of sheets.slice(0, MAX_SHEETS)) {
    const start = records.findIndex(record => record.offset === sheet.position);
    if (start < 0) continue;
    parsed.push({ ...sheetOf(records, start, shared), name: sheet.hidden ? `${sheet.name}（隐藏）` : sheet.name });
  }
  if (!parsed.length) throw new Error("工作簿中没有工作表");
  return { kind: "sheet", sheets: parsed };
}

module.exports = { readDoc, readXls };
