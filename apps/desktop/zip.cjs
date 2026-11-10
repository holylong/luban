const { inflateRawSync } = require("node:zlib");

const EOCD = 0x06054b50;
const CENTRAL = 0x02014b50;
// A slide deck is a zip; refuse a decompression bomb before it fills memory.
const MAX_ENTRY_BYTES = 64 * 1024 * 1024;

/** Minimal read-only ZIP reader for OOXML packages. Only the central directory
 *  is indexed; entry names are keys and are never used as filesystem paths. */
function openZip(buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.length < 22) throw new Error("不是有效的压缩包");
  let eocd = -1;
  for (let index = buffer.length - 22; index >= Math.max(0, buffer.length - 66000); index--) {
    if (buffer.readUInt32LE(index) === EOCD) { eocd = index; break; }
  }
  if (eocd < 0) throw new Error("不是有效的压缩包");
  const count = buffer.readUInt16LE(eocd + 10);
  const directorySize = buffer.readUInt32LE(eocd + 12);
  const directoryOffset = buffer.readUInt32LE(eocd + 16);
  const limit = Math.min(buffer.length, directoryOffset + directorySize);
  const entries = new Map();
  let offset = directoryOffset;
  for (let index = 0; index < count && offset + 46 <= limit; index++) {
    if (buffer.readUInt32LE(offset) !== CENTRAL) break;
    const flags = buffer.readUInt16LE(offset + 8);
    const method = buffer.readUInt16LE(offset + 10);
    const compressedSize = buffer.readUInt32LE(offset + 20);
    const size = buffer.readUInt32LE(offset + 24);
    const nameLength = buffer.readUInt16LE(offset + 28);
    const extraLength = buffer.readUInt16LE(offset + 30);
    const commentLength = buffer.readUInt16LE(offset + 32);
    const localOffset = buffer.readUInt32LE(offset + 42);
    const name = buffer.toString("utf8", offset + 46, offset + 46 + nameLength);
    if (!(flags & 1) && localOffset + 30 <= buffer.length) entries.set(name, { method, compressedSize, size, localOffset });
    offset += 46 + nameLength + extraLength + commentLength;
  }
  return {
    has: name => entries.has(name),
    list: () => [...entries.keys()],
    read(name) {
      const entry = entries.get(name);
      if (!entry) return undefined;
      const nameLength = buffer.readUInt16LE(entry.localOffset + 26);
      const extraLength = buffer.readUInt16LE(entry.localOffset + 28);
      const start = entry.localOffset + 30 + nameLength + extraLength;
      const data = buffer.subarray(start, start + entry.compressedSize);
      if (entry.method === 0) return data;
      if (entry.method !== 8) throw new Error("不支持的压缩方式");
      try { return inflateRawSync(data, { maxOutputLength: MAX_ENTRY_BYTES }); }
      catch { throw new Error("压缩条目损坏或过大"); }
    },
    text(name) {
      const data = this.read(name);
      return data ? data.toString("utf8") : undefined;
    },
  };
}

module.exports = { openZip, MAX_ENTRY_BYTES };
