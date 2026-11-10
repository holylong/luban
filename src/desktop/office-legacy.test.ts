import { describe, expect, it } from "vitest";
import { createRequire } from "node:module";

const fixtures = createRequire(import.meta.url)("../../scripts/test-fixtures.cjs");
const { readDoc, readXls } = createRequire(import.meta.url)("../../apps/desktop/office-legacy.cjs");
const { readCompound } = createRequire(import.meta.url)("../../apps/desktop/ole.cjs");

describe("compound files", () => {
  it("lists and reads named streams from a Word document", () => {
    const file = fixtures.wordDocOf("你好");
    const compound = readCompound(file);
    expect(compound.names().sort()).toEqual(["0Table", "WordDocument"]);
    expect(compound.read("WordDocument").readUInt16LE(0)).toBe(0xa5ec);
  });

  it("rejects files that are not compound documents", () => {
    expect(() => readCompound(Buffer.from("plain text"))).toThrow(/复合文档/);
  });
});

describe("legacy Word preview", () => {
  it("extracts paragraphs from the piece table", () => {
    const model = readDoc(fixtures.wordDocOf("第一段\r第二段\r第三段"));
    expect(model.kind).toBe("word");
    expect(model.blocks).toEqual([
      { type: "paragraph", text: "第一段" },
      { type: "paragraph", text: "第二段" },
      { type: "paragraph", text: "第三段" },
    ]);
  });

  it("drops field instructions but keeps their results", () => {
    const model = readDoc(fixtures.wordDocOf("前\u0013 HYPERLINK \u0014链接\u0015后"));
    expect(model.blocks.map((block: { text?: string }) => block.text)).toEqual(["前链接后"]);
  });

  it("refuses a package that is not a Word document", () => {
    expect(() => readDoc(Buffer.alloc(0))).toThrow();
  });
});

describe("legacy Excel preview", () => {
  it("reads shared strings and numbers from the sheet substream", () => {
    const model = readXls(fixtures.xlsOf());
    expect(model.kind).toBe("sheet");
    expect(model.sheets[0]).toMatchObject({ name: "Data", columns: 2 });
    expect(model.sheets[0].rows).toEqual([
      { index: 1, cells: [{ text: "Hello" }, { text: "42.5", numeric: true }] },
    ]);
  });

  it("refuses a package that is not a workbook", () => {
    expect(() => readXls(Buffer.from("not a workbook"))).toThrow();
  });
});
