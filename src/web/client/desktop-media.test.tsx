import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { documentPreviewKind, mediaEntrySource, mediaKind, mediaSource } from "./desktop-media";
import { DesktopMediaView } from "./desktop-media-view";
import { DesktopDocumentView } from "./desktop-document-view";
import type { DiagramPreview, SlidesPreview } from "./desktop-preview";

describe("desktop media preview", () => {
  it("classifies audio, video, image and PDF paths", () => {
    expect(mediaKind("clip.MP4")).toBe("video");
    expect(mediaKind("voice/note.m4a")).toBe("audio");
    expect(mediaKind("img/logo.png")).toBe("image");
    expect(mediaKind("docs/report.PDF")).toBe("pdf");
    expect(mediaKind("src/app.ts")).toBeNull();
    expect(mediaKind("README")).toBeNull();
  });

  it("routes slide decks and draw.io files to parsed previews", () => {
    expect(documentPreviewKind("deck.pptx")).toBe("slides");
    expect(documentPreviewKind("deck.PPTM")).toBe("slides");
    expect(documentPreviewKind("flow.drawio")).toBe("diagram");
    expect(documentPreviewKind("flow.drawio.svg")).toBe("diagram");
    expect(documentPreviewKind("flow.drawio.png")).toBe("diagram");
    expect(mediaKind("flow.drawio.png")).toBe("image"); // the editor checks parsed previews first
    expect(documentPreviewKind("report.pdf")).toBeNull();
    expect(documentPreviewKind("src/app.ts")).toBeNull();
  });

  it("builds an encoded workspace URL", () => {
    expect(mediaSource("clip.mp4")).toBe("luban-media://workspace/clip.mp4");
    expect(mediaSource("/media/我的 视频.mp4")).toBe(`luban-media://workspace/media/${encodeURIComponent("我的 视频")}.mp4`);
    expect(mediaEntrySource("slides 演示.pptx", "ppt/media/image 1.png"))
      .toBe(`luban-media://workspace/${encodeURIComponent("slides 演示")}.pptx?entry=${encodeURIComponent("ppt/media/image 1.png")}`);
  });

  it("renders a player instead of the text editor", () => {
    const video = renderToStaticMarkup(<DesktopMediaView path="clip.mp4" kind="video" />);
    expect(video).toContain("<video");
    expect(video).toContain("controls");
    expect(video).toContain("luban-media://workspace/clip.mp4");
    expect(video).not.toContain("<textarea");

    const audio = renderToStaticMarkup(<DesktopMediaView path="voice.mp3" kind="audio" />);
    expect(audio).toContain("<audio");

    const image = renderToStaticMarkup(<DesktopMediaView path="logo.png" kind="image" onClose={() => {}} />);
    expect(image).toContain("<img");
    expect(image).toContain("关闭预览");
  });

  it("embeds a PDF in Chromium's viewer", () => {
    const pdf = renderToStaticMarkup(<DesktopMediaView path="docs/report.pdf" kind="pdf" />);
    expect(pdf).toContain("<embed");
    expect(pdf).toContain('type="application/pdf"');
    expect(pdf).toContain("luban-media://workspace/docs/report.pdf");
    expect(pdf).toContain("PDF 预览");
  });
});

const slides: SlidesPreview = {
  kind: "slides",
  path: "deck.pptx",
  width: 1280,
  height: 720,
  slides: [{
    index: 1,
    notes: "讲稿",
    shapes: [
      { kind: "rect", x: 0, y: 0, w: 1280, h: 720, fill: "#FFFFFF" },
      {
        kind: "roundRect", x: 80, y: 60, w: 600, h: 120, fill: "#1F4E79", stroke: "#FFFFFF", strokeWidth: 2,
        lines: [{ text: "季度回顾", x: 90, y: 130, size: 40, align: "left", bold: true, color: "#FFFFFF" }],
      },
      { kind: "image", x: 80, y: 200, w: 320, h: 180, image: "ppt/media/image1.png" },
      { kind: "ellipse", x: 500, y: 200, w: 100, h: 100, fill: "#FFC000" },
    ],
  }],
};

const diagram: DiagramPreview = {
  kind: "diagram",
  path: "flow.drawio",
  pages: [{
    name: "流程",
    view: { x: 0, y: 0, width: 400, height: 200 },
    nodes: [{
      kind: "roundRect", x: 20, y: 20, w: 120, h: 60, fill: "#DAE8FC", stroke: "#6C8EBF",
      strokeWidth: 1, fontSize: 12, align: "center", color: "#000000", lines: ["开始"],
    }],
    edges: [{ points: [[140, 50], [300, 50]], stroke: "#000000", strokeWidth: 1, arrow: true, label: "继续" }],
  }],
};

describe("desktop parsed previews", () => {
  it("renders slides, their notes and embedded images", () => {
    const markup = renderToStaticMarkup(<DesktopDocumentView path="deck.pptx" model={slides} />);
    expect(markup).toContain('viewBox="0 0 1280 720"');
    expect(markup).toContain("季度回顾");
    expect(markup).toContain("备注：讲稿");
    expect(markup).toContain("entry=ppt%2Fmedia%2Fimage1.png");
    expect(markup).toContain("幻灯片预览");
    expect(markup).not.toContain("<textarea");
  });

  it("renders one scaled SVG per draw.io page", () => {
    const markup = renderToStaticMarkup(<DesktopDocumentView path="flow.drawio" model={diagram} />);
    expect(markup).toContain('viewBox="0 0 400 200"');
    expect(markup).toContain("<polyline");
    expect(markup).toContain("继续");
    expect(markup).toContain("draw.io 图形预览");
  });

  it("shows the parse failure instead of an empty stage", () => {
    const markup = renderToStaticMarkup(<DesktopDocumentView path="broken.pptx" kind="slides" error="不是有效的 PPTX 文件" />);
    expect(markup).toContain('role="alert"');
    expect(markup).toContain("不是有效的 PPTX 文件");
    expect(markup).toContain("幻灯片预览");
    const loading = renderToStaticMarkup(<DesktopDocumentView path="slow.pptx" onClose={() => {}} />);
    expect(loading).toContain("正在解析…");
  });
});
