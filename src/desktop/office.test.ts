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
