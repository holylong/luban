// Compound File Binary (OLE2) reader.
//
// Word 97 and Excel 97-2003 store a single document as a small filesystem
// inside one file. Previews only need named streams, so this reader exposes
// exactly that and refuses anything larger than the caller already bounded.

const MAGIC = Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]);
const END_OF_CHAIN = 0xfffffffe;
const FREE = 0xffffffff;
const MAX_CHAIN = 1 << 22;

/**
 * Index one compound file. Streams are read on demand so a 50 MB spreadsheet
 * does not copy the whole file again for the sheet it needs.
 */
function readCompound(buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.length < 512 || !buffer.subarray(0, 8).equals(MAGIC)) {
    throw new Error("不是有效的旧版 Office 复合文档");
  }
  const sectorShift = buffer.readUInt16LE(0x1e);
  const miniShift = buffer.readUInt16LE(0x20);
  if (sectorShift !== 9 && sectorShift !== 12) throw new Error("复合文档扇区大小异常");
  if (miniShift !== 6) throw new Error("复合文档迷你扇区大小异常");
  const sectorSize = 1 << sectorShift;
  const miniSize = 1 << miniShift;
  const miniCutoff = buffer.readUInt32LE(0x38);
  const firstDirectory = buffer.readUInt32LE(0x30);
  const firstMiniFat = buffer.readUInt32LE(0x3c);
  const fatCount = buffer.readUInt32LE(0x2c);
  const firstDifat = buffer.readUInt32LE(0x44);
  const difatCount = buffer.readUInt32LE(0x48);

  const sectorOffset = sector => (sector + 1) * sectorSize;

  // DIFAT: 109 entries in the header, then a chain of sectors that hold more.
  const fatSectors = [];
  for (let index = 0; index < 109 && fatSectors.length < fatCount; index++) {
    const sector = buffer.readUInt32LE(0x4c + index * 4);
    if (sector < 0xfffffffa) fatSectors.push(sector);
  }
  let difat = firstDifat;
  for (let guard = 0; guard < difatCount && difat < 0xfffffffa; guard++) {
    const start = sectorOffset(difat);
    if (start + sectorSize > buffer.length) throw new Error("复合文档 DIFAT 越界");
    const per = sectorSize / 4;
    for (let index = 0; index < per - 1 && fatSectors.length < fatCount; index++) {
      const sector = buffer.readUInt32LE(start + index * 4);
      if (sector < 0xfffffffa) fatSectors.push(sector);
    }
    difat = buffer.readUInt32LE(start + (per - 1) * 4);
  }
  const fat = Buffer.alloc(fatSectors.length * sectorSize / 4 * 4);
  fatSectors.forEach((sector, index) => {
    const start = sectorOffset(sector);
    if (start + sectorSize > buffer.length) throw new Error("复合文档 FAT 越界");
    buffer.copy(fat, index * sectorSize, start, start + sectorSize);
  });
  const fatEntry = sector => {
    const offset = sector * 4;
    return offset + 4 <= fat.length ? fat.readUInt32LE(offset) : END_OF_CHAIN;
  };

  const chain = start => {
    const sectors = [];
    let sector = start;
    while (sector !== END_OF_CHAIN && sector !== FREE && sectors.length < MAX_CHAIN) {
      if (sector >= fat.length / 4) throw new Error("复合文档扇区链越界");
      sectors.push(sector);
      sector = fatEntry(sector);
    }
    return sectors;
  };

  const readChain = (start, size) => {
    const sectors = chain(start);
    const total = Math.min(size ?? sectors.length * sectorSize, sectors.length * sectorSize);
    const output = Buffer.alloc(total);
    let written = 0;
    for (const sector of sectors) {
      const offset = sectorOffset(sector);
      const take = Math.min(sectorSize, total - written);
      if (offset + take > buffer.length) break;
      buffer.copy(output, written, offset, offset + take);
      written += take;
      if (written >= total) break;
    }
    return output.subarray(0, written);
  };

  const directory = (() => {
    const bytes = readChain(firstDirectory);
    const entries = [];
    for (let offset = 0; offset + 128 <= bytes.length; offset += 128) {
      const nameLength = bytes.readUInt16LE(offset + 0x40);
      const type = bytes[offset + 0x42];
      if (!type || nameLength < 2 || nameLength > 64) continue;
      entries.push({
        name: bytes.toString("utf16le", offset, offset + nameLength - 2),
        type,
        start: bytes.readUInt32LE(offset + 0x74),
        size: bytes.readUInt32LE(offset + 0x78),
      });
    }
    return entries;
  })();
  const root = directory.find(entry => entry.type === 5);
  let miniStream;
  let miniFat;
  const miniStreamOf = () => {
    if (miniStream === undefined) miniStream = root ? readChain(root.start, root.size) : Buffer.alloc(0);
    return miniStream;
  };
  const miniFatOf = () => {
    if (miniFat === undefined) miniFat = firstMiniFat < 0xfffffffa ? readChain(firstMiniFat) : Buffer.alloc(0);
    return miniFat;
  };
  const readMini = (start, size) => {
    const mini = miniStreamOf();
    const table = miniFatOf();
    const output = Buffer.alloc(size);
    let written = 0;
    let sector = start;
    while (sector !== END_OF_CHAIN && sector !== FREE && written < size) {
      const offset = sector * miniSize;
      if (offset >= mini.length) break;
      const take = Math.min(miniSize, size - written, mini.length - offset);
      mini.copy(output, written, offset, offset + take);
      written += take;
      const next = sector * 4 + 4 <= table.length ? table.readUInt32LE(sector * 4) : END_OF_CHAIN;
      if (next === sector) break;
      sector = next;
    }
    return output.subarray(0, written);
  };

  const find = name => {
    const wanted = String(name).toLowerCase();
    return directory.find(entry => entry.type === 2 && entry.name.toLowerCase() === wanted);
  };

  return {
    /** Case-insensitive stream lookup, like the API Word and Excel read through. */
    has: name => Boolean(find(name)),
    names: () => directory.filter(entry => entry.type === 2).map(entry => entry.name),
    read(name) {
      const entry = find(name);
      if (!entry) return undefined;
      return entry.size < miniCutoff || !root ? readMini(entry.start, entry.size) : readChain(entry.start, entry.size);
    },
  };
}

module.exports = { readCompound };
