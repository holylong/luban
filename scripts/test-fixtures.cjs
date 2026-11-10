// Test-only helper: build a ZIP archive in memory so parser tests can create a
// minimal OOXML package without a dependency or a child process.
const { deflateRawSync } = require("node:zlib");

/** @param {Record<string, string | Buffer>} files
 *  @param {{ store?: boolean }} [options] */
function zipOf(files, options = {}) {
  const locals = [];
  const centrals = [];
  let offset = 0;
  for (const [name, value] of Object.entries(files)) {
    const raw = Buffer.isBuffer(value) ? value : Buffer.from(String(value), "utf8");
    const data = options.store ? raw : deflateRawSync(raw);
    const nameBytes = Buffer.from(name, "utf8");
    const local = Buffer.alloc(30 + nameBytes.length);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0x0800, 6);
    local.writeUInt16LE(options.store ? 0 : 8, 8);
    local.writeUInt32LE(0, 10);
    local.writeUInt32LE(0, 14);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(raw.length, 22);
    local.writeUInt16LE(nameBytes.length, 26);
    local.writeUInt16LE(0, 28);
    nameBytes.copy(local, 30);
    locals.push(local, data);

    const central = Buffer.alloc(46 + nameBytes.length);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0x0800, 8);
    central.writeUInt16LE(options.store ? 0 : 8, 10);
    central.writeUInt32LE(0, 12);
    central.writeUInt32LE(0, 16);
    central.writeUInt32LE(data.length, 20);
    central.writeUInt32LE(raw.length, 24);
    central.writeUInt16LE(nameBytes.length, 28);
    central.writeUInt16LE(0, 30);
    central.writeUInt16LE(0, 32);
    central.writeUInt16LE(0, 34);
    central.writeUInt16LE(0, 36);
    central.writeUInt32LE(0, 38);
    central.writeUInt32LE(offset, 42);
    nameBytes.copy(central, 46);
    centrals.push(central);
    offset += local.length + data.length;
  }
  const directory = Buffer.concat(centrals);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(0, 4);
  eocd.writeUInt16LE(0, 6);
  eocd.writeUInt16LE(centrals.length, 8);
  eocd.writeUInt16LE(centrals.length, 10);
  eocd.writeUInt32LE(directory.length, 12);
  eocd.writeUInt32LE(offset, 16);
  eocd.writeUInt16LE(0, 20);
  return Buffer.concat([...locals, directory, eocd]);
}

/** Build a one-slide pptx package with a title, a body bullet and an image. */
function pptxOf({ title = "季度回顾", body = "第一点\n第二点", store = false } = {}) {
  const emu = value => String(value);
  const slide = `<?xml version="1.0" encoding="UTF-8"?>
<p:sld xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">
<p:cSld><p:bg><p:bgPr><a:solidFill><a:srgbClr val="F2F2F2"/></a:solidFill></p:bgPr></p:bg><p:spTree>
<p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/></p:nvGrpSpPr><p:grpSpPr/>
<p:sp><p:nvSpPr><p:cNvPr id="2" name="标题"/><p:cNvSpPr/><p:nvPr><p:ph type="title"/></p:nvPr></p:nvSpPr>
<p:spPr><a:xfrm><a:off x="${emu(838200)}" y="${emu(365125)}"/><a:ext cx="${emu(10515600)}" cy="${emu(1325563)}"/></a:xfrm><a:prstGeom prst="rect"/></p:spPr>
<p:txBody><a:bodyPr/><a:p><a:r><a:rPr lang="zh-CN" b="1"/><a:t>${title}</a:t></a:r></a:p></p:txBody></p:sp>
<p:sp><p:nvSpPr><p:cNvPr id="3" name="正文"/><p:cNvSpPr/><p:nvPr><p:ph idx="1"/></p:nvPr></p:nvSpPr>
<p:spPr><a:xfrm><a:off x="${emu(838200)}" y="${emu(1825625)}"/><a:ext cx="${emu(10515600)}" cy="${emu(4351338)}"/></a:xfrm><a:prstGeom prst="rect"/><a:solidFill><a:srgbClr val="FFFFFF"/></a:solidFill><a:ln w="19050"><a:solidFill><a:srgbClr val="4472C4"/></a:solidFill></a:ln></p:spPr>
<p:txBody><a:bodyPr anchor="ctr"/><a:p><a:pPr><a:buChar char="&#8226;"/></a:pPr><a:r><a:rPr lang="zh-CN" sz="2400"/><a:t>${body.split("\n")[0]}</a:t></a:r></a:p></p:txBody></p:sp>
<p:grpSp><p:nvGrpSpPr><p:cNvPr id="10" name="组"/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr>
<p:grpSpPr><a:xfrm><a:off x="${emu(838200)}" y="${emu(4572000)}"/><a:ext cx="${emu(3048000)}" cy="${emu(1143000)}"/><a:chOff x="0" y="0"/><a:chExt cx="${emu(2048000)}" cy="${emu(762000)}"/></a:xfrm></p:grpSpPr>
<p:pic><p:nvPicPr><p:cNvPr id="11" name="图片"/><p:cNvPicPr/><p:nvPr/></p:nvPicPr>
<p:blipFill><a:blip r:embed="rId2"/></p:blipFill><p:spPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="${emu(1024000)}" cy="${emu(762000)}"/></a:xfrm><a:prstGeom prst="rect"/></p:spPr></p:pic>
</p:grpSp>
</p:spTree></p:cSld><p:clrMapOvr><a:masterClrMapping/></p:clrMapOvr></p:sld>`;
  return zipOf({
    "[Content_Types].xml": `<?xml version="1.0" encoding="UTF-8"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"/>`,
    "ppt/presentation.xml": `<?xml version="1.0" encoding="UTF-8"?><p:presentation xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><p:sldIdLst><p:sldId id="256" r:id="rId2"/></p:sldIdLst><p:sldSz cx="12192000" cy="6858000"/></p:presentation>`,
    "ppt/_rels/presentation.xml.rels": `<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slide" Target="slides/slide1.xml"/></Relationships>`,
    "ppt/slides/slide1.xml": slide,
    "ppt/slides/_rels/slide1.xml.rels": `<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="../media/image1.png"/><Relationship Id="rId3" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/notesSlide" Target="../notesSlides/notesSlide1.xml"/></Relationships>`,
    "ppt/media/image1.png": Buffer.from("89504e470d0a1a0a0000000d49484452", "hex"),
    "ppt/theme/theme1.xml": `<?xml version="1.0" encoding="UTF-8"?><a:theme xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" name="Office"><a:themeElements><a:clrScheme name="Office"><a:dk1><a:sysClr val="windowText" lastClr="111111"/></a:dk1><a:lt1><a:sysClr val="window" lastClr="FFFFFF"/></a:lt1><a:accent1><a:srgbClr val="1F4E79"/></a:accent1></a:clrScheme></a:themeElements></a:theme>`,
    "ppt/notesSlides/notesSlide1.xml": `<?xml version="1.0" encoding="UTF-8"?><p:notes xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"><p:cSld><p:spTree><p:sp><p:txBody><a:p><a:r><a:t>讲稿内容</a:t></a:r></a:p></p:txBody></p:sp></p:spTree></p:cSld></p:notes>`,
  }, { store });
}


const SECTOR = 512;
const END_OF_CHAIN = 0xfffffffe;
const FREE_SECTOR = 0xffffffff;

/**
 * Build a minimal Compound File Binary image holding the given streams.
 * Streams are padded past the 4096-byte mini-stream cutoff so the fixture stays
 * inside one FAT sector instead of reimplementing the mini filesystem.
 */
function compoundOf(streams) {
  const items = Object.entries(streams).map(([name, value]) => ({
    name, data: Buffer.isBuffer(value) ? value : Buffer.from(String(value), "utf8"),
  }));
  const padded = items.map(item => item.data.length >= 4096 ? item.data : Buffer.concat([item.data, Buffer.alloc(4096 - item.data.length)]));
  const streamSectors = padded.map(data => Math.ceil(data.length / SECTOR));
  const directorySectors = Math.ceil((items.length + 1) / 4);
  const dataSectors = streamSectors.reduce((total, count) => total + count, 0);
  const totalSectors = 1 + directorySectors + dataSectors;
  if (totalSectors > 128) throw new Error("fixture too large for one FAT sector");

  const image = Buffer.alloc((totalSectors + 1) * SECTOR);
  image.writeUInt32LE(0xe011cfd0, 0);
  image.writeUInt32LE(0xe11ab1a1, 4);
  image.writeUInt16LE(0x003e, 0x18);
  image.writeUInt16LE(3, 0x1a);
  image.writeUInt16LE(0xfffe, 0x1c);
  image.writeUInt16LE(9, 0x1e);
  image.writeUInt16LE(6, 0x20);
  image.writeUInt32LE(1, 0x2c);
  image.writeUInt32LE(1, 0x30);
  image.writeUInt32LE(4096, 0x38);
  image.writeUInt32LE(END_OF_CHAIN, 0x3c);
  image.writeUInt32LE(0, 0x40);
  image.writeUInt32LE(END_OF_CHAIN, 0x44);
  image.writeUInt32LE(0, 0x48);
  for (let index = 0; index < 109; index++) image.writeUInt32LE(index === 0 ? 0 : FREE_SECTOR, 0x4c + index * 4);

  const fat = Buffer.alloc(SECTOR, 0xff);
  const fatWrite = (sector, value) => fat.writeUInt32LE(value, sector * 4);
  fatWrite(0, 0xfffffffd);
  for (let index = 0; index < directorySectors; index++) fatWrite(1 + index, index === directorySectors - 1 ? END_OF_CHAIN : 2 + index);
  let sector = 1 + directorySectors;
  for (const count of streamSectors) {
    for (let index = 0; index < count; index++) fatWrite(sector + index, index === count - 1 ? END_OF_CHAIN : sector + index + 1);
    sector += count;
  }
  fat.copy(image, SECTOR);

  const directory = Buffer.alloc(directorySectors * SECTOR);
  const entry = (index, { name, type, start, size, child, right }) => {
    const base = index * 128;
    const nameBytes = Buffer.from(name, "utf16le").subarray(0, 62);
    nameBytes.copy(directory, base);
    directory.writeUInt16LE(nameBytes.length + 2, base + 0x40);
    directory.writeUInt8(type, base + 0x42);
    directory.writeUInt8(1, base + 0x43);
    directory.writeUInt32LE(FREE_SECTOR, base + 0x44);
    directory.writeUInt32LE(right ?? FREE_SECTOR, base + 0x48);
    directory.writeUInt32LE(child ?? FREE_SECTOR, base + 0x4c);
    directory.writeUInt32LE(start, base + 0x74);
    directory.writeUInt32LE(size, base + 0x78);
  };
  entry(0, { name: "Root Entry", type: 5, start: END_OF_CHAIN, size: 0, child: 1 });
  padded.forEach((data, index) => entry(index + 1, {
    name: items[index].name, type: 2, start: (1 + directorySectors) + streamSectors.slice(0, index).reduce((total, count) => total + count, 0),
    size: data.length, right: index + 2 <= items.length ? index + 2 : FREE_SECTOR,
  }));
  directory.copy(image, (1 + 1) * SECTOR);

  let offset = (2 + directorySectors) * SECTOR;
  for (const data of padded) { data.copy(image, offset); offset += data.length; }
  return image;
}

/** A Word 97 document whose single text piece holds the given text. */
function wordDocOf(text) {
  const encoded = Buffer.from(text, "utf16le");
  const word = Buffer.alloc(0x800 + encoded.length);
  word.writeUInt16LE(0xa5ec, 0);
  word.writeUInt16LE(0x00c1, 2);
  word.writeUInt16LE(0, 0x0a);
  word.writeUInt32LE(text.length, 0x4c);
  encoded.copy(word, 0x800);
  const clx = Buffer.alloc(5 + 8 + 8);
  clx.writeUInt8(0x02, 0);
  clx.writeUInt32LE(16, 1);
  clx.writeUInt32LE(0, 5);
  clx.writeUInt32LE(text.length, 9);
  clx.writeUInt32LE(0x800, 5 + 8 + 2);
  word.writeUInt32LE(0, 0x1a2);
  word.writeUInt32LE(clx.length, 0x1a6);
  return compoundOf({ WordDocument: word, "0Table": clx });
}

/** A BIFF8 workbook with one sheet, one shared string and one number. */
function xlsOf() {
  const record = (type, data) => {
    const head = Buffer.alloc(4);
    head.writeUInt16LE(type, 0);
    head.writeUInt16LE(data.length, 2);
    return Buffer.concat([head, data]);
  };
  const bof = type => {
    const data = Buffer.alloc(16);
    data.writeUInt16LE(0x0600, 0);
    data.writeUInt16LE(type, 2);
    return record(0x0809, data);
  };
  const boundsheet = (offset, name) => {
    const chars = Buffer.from(name, "utf8");
    const data = Buffer.alloc(8 + chars.length);
    data.writeUInt32LE(offset, 0);
    data.writeUInt16LE(0, 4);
    data.writeUInt8(chars.length, 6);
    data.writeUInt8(0, 7);
    chars.copy(data, 8);
    return record(0x0085, data);
  };
  const sst = Buffer.alloc(8 + 3 + 5 * 2);
  sst.writeUInt32LE(1, 0);
  sst.writeUInt32LE(1, 4);
  sst.writeUInt16LE(5, 8);
  sst.writeUInt8(1, 10);
  Buffer.from("Hello", "utf16le").copy(sst, 11);
  const label = Buffer.alloc(10);
  label.writeUInt16LE(0, 0);
  label.writeUInt16LE(0, 2);
  label.writeUInt32LE(0, 6);
  const number = Buffer.alloc(14);
  number.writeUInt16LE(0, 0);
  number.writeUInt16LE(1, 2);
  number.writeDoubleLE(42.5, 6);
  const globals = Buffer.concat([bof(0x0005), boundsheet(0, "Data"), record(0x00fc, sst), record(0x000a, Buffer.alloc(0))]);
  globals.writeUInt32LE(globals.length, 24);
  const sheet = Buffer.concat([bof(0x0010), record(0x00fd, label), record(0x0203, number), record(0x000a, Buffer.alloc(0))]);
  return compoundOf({ Workbook: Buffer.concat([globals, sheet]) });
}

module.exports = { zipOf, pptxOf, compoundOf, wordDocOf, xlsOf };
