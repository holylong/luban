import { describe, expect, it } from "vitest";
import { createRequire } from "node:module";

const { readPptx } = createRequire(import.meta.url)("../../apps/desktop/office.cjs");
const { pptxOf, zipOf } = createRequire(import.meta.url)("../../scripts/test-fixtures.cjs");

describe("pptx preview", () => {
  it("reads slides, text, theme fills, images and notes", () => {
    const model = readPptx(pptxOf());
    expect(model.kind).toBe("slides");
    expect(model.width).toBe(1280);
    expect(model.height).toBe(720);
    expect(model.slides).toHaveLength(1);
    const slide = model.slides[0];
    expect(slide.index).toBe(1);
    expect(slide.notes).toBe("讲稿内容");
    // Slide background comes from p:bg.
    expect(slide.shapes[0]).toMatchObject({ kind: "rect", x: 0, y: 0, w: 1280, h: 720, fill: "#F2F2F2" });
    const title = slide.shapes[1];
    expect(title.lines?.[0]).toMatchObject({ text: "季度回顾", bold: true });
    const body = slide.shapes[2];
    expect(body).toMatchObject({ fill: "#FFFFFF", stroke: "#4472C4", strokeWidth: 2 });
    expect(body.lines?.[0]?.text).toBe("• 第一点");
    // Group geometry scales the nested picture into slide coordinates.
    const image = slide.shapes[3];
    expect(image).toMatchObject({ kind: "image", image: "ppt/media/image1.png", x: 88, y: 480, w: 160, h: 120 });
  });

  it("reads a package whose entries are stored instead of deflated", () => {
    const stored = readPptx(pptxOf({ store: true }));
    expect(stored.slides[0].shapes[1].lines?.[0]?.text).toBe("季度回顾");
    expect(stored.slides[0].shapes[3].image).toBe("ppt/media/image1.png");
  });

  it("rejects a package that is not a deck", () => {
    expect(() => readPptx(Buffer.from("not a zip"))).toThrow();
    expect(() => readPptx(zipOf({ "ppt/theme/theme1.xml": "<theme/>" }))).toThrow(/PPTX/);
    expect(() => readPptx(zipOf({
      "ppt/presentation.xml": `<p:presentation xmlns:p="p" xmlns:r="r"><p:sldSz cx="9144000" cy="6858000"/></p:presentation>`,
    }))).toThrow(/幻灯片/);
  });
});

describe("xlsx preview", () => {
  const { readXlsx, readDocx } = createRequire(import.meta.url)("../../apps/desktop/office.cjs");

  const packageOf = (sheetXml, extra = {}) => zipOf({
    "xl/workbook.xml": `<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><workbookPr/><sheets><sheet name="数据" sheetId="1" r:id="rId1"/></sheets></workbook>`,
    "xl/_rels/workbook.xml.rels": `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="worksheet" Target="worksheets/sheet1.xml"/></Relationships>`,
    "xl/sharedStrings.xml": `<sst><si><t>名称</t></si><si><r><t>富</t></r><r><t>文本</t></r></si></sst>`,
    "xl/styles.xml": `<styleSheet><cellXfs count="2"><xf numFmtId="0"/><xf numFmtId="14"/></cellXfs></styleSheet>`,
    "xl/worksheets/sheet1.xml": sheetXml,
    ...extra,
  });

  it("reads shared, inline and numeric cells plus a date style", () => {
    const model = readXlsx(packageOf(`<worksheet><sheetData>
      <row r="1"><c r="A1" t="s"><v>0</v></c><c r="B1" t="s"><v>1</v></c></row>
      <row r="2"><c r="A2"><v>42.5</v></c><c r="C2" s="1"><v>45000</v></c></row>
      <row r="3"><c r="B3" t="inlineStr"><is><t>内联</t></is></c><c r="A3" t="b"><v>1</v></c></row>
    </sheetData></worksheet>`));
    expect(model.kind).toBe("sheet");
    expect(model.sheets).toHaveLength(1);
    const sheet = model.sheets[0];
    expect(sheet.name).toBe("数据");
    expect(sheet.columns).toBe(3);
    expect(sheet.rows[0]!.cells).toEqual([{ text: "名称" }, { text: "富文本" }]);
    expect(sheet.rows[1]!.cells[0]).toEqual({ text: "42.5", numeric: true });
    expect(sheet.rows[1]!.cells[1]).toBeNull();
    expect(sheet.rows[1]!.cells[2]).toEqual({ text: "2023-03-15" });
    expect(sheet.rows[2]!.cells).toEqual([{ text: "TRUE" }, { text: "内联" }]);
  });

  it("caps very large sheets and says how much it hid", () => {
    const rows = Array.from({ length: 405 }, (_, index) => `<row r="${index + 1}"><c r="A${index + 1}"><v>${index}</v></c></row>`).join("");
    const sheet = readXlsx(packageOf(`<worksheet><sheetData>${rows}</sheetData></worksheet>`)).sheets[0];
    expect(sheet.rows).toHaveLength(400);
    expect(sheet.truncatedRows).toBe(5);
  });

  it("rejects a package that is not a workbook", () => {
    expect(() => readXlsx(zipOf({ "word/document.xml": "<document/>" }))).toThrow(/XLSX/);
  });

  it("reads headings, lists, tables and inline formatting from a docx", () => {
    const model = readDocx(zipOf({
      "word/document.xml": `<w:document xmlns:w="w"><w:body>
        <w:p><w:pPr><w:pStyle w:val="Heading1"/></w:pPr><w:r><w:t>标题</w:t></w:r></w:p>
        <w:p><w:r><w:t>正文</w:t></w:r><w:r><w:tab/><w:t>制表</w:t></w:r></w:p>
        <w:p><w:pPr><w:numPr><w:numId w:val="1"/></w:numPr></w:pPr><w:r><w:t>第一项</w:t></w:r></w:p>
        <w:p><w:pPr><w:numPr><w:numId w:val="1"/></w:numPr></w:pPr><w:r><w:t>第二项</w:t></w:r></w:p>
        <w:tbl><w:tr><w:tc><w:p><w:r><w:t>A</w:t></w:r></w:p></w:tc><w:tc><w:p><w:r><w:t>B</w:t></w:r></w:p></w:tc></w:tr></w:tbl>
        <w:sdt><w:sdtContent><w:p><w:r><w:t>控件里的文字</w:t></w:r></w:p></w:sdtContent></w:sdt>
      </w:body></w:document>`,
      "word/styles.xml": `<w:styles xmlns:w="w"><w:style w:styleId="Heading1"><w:name w:val="heading 1"/></w:style></w:styles>`,
      "word/numbering.xml": `<w:numbering><w:abstractNum w:abstractNumId="0"><w:lvl w:ilvl="0"><w:numFmt w:val="decimal"/></w:lvl></w:abstractNum><w:num w:numId="1"><w:abstractNumId w:val="0"/></w:num></w:numbering>`,
    }));
    expect(model.kind).toBe("word");
    expect(model.blocks).toEqual([
      { type: "heading", level: 1, text: "标题" },
      { type: "paragraph", text: "正文\t制表" },
      { type: "list", ordered: true, items: ["第一项", "第二项"] },
      { type: "table", rows: [["A", "B"]] },
      { type: "paragraph", text: "控件里的文字" },
    ]);
  });

  it("rejects a package that is not a document", () => {
    expect(() => readDocx(zipOf({ "xl/workbook.xml": "<workbook/>" }))).toThrow(/DOCX/);
  });
});
