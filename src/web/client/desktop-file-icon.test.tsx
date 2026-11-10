import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { DesktopFileIcon, fileIconKind } from "./desktop-file-icon";

describe("desktop file format icons", () => {
  it.each([
    ["src/app.TSX", "code"], ["main.py", "code"], ["Dockerfile", "code"],
    ["Makefile", "code"], ["CMakeLists.txt", "code"], ["图片.PNG", "image"],
    ["report.PDF", "pdf"], ["说明.docx", "word"], ["old.doc", "word"],
    ["预算.xlsx", "sheet"], ["old.xls", "sheet"], ["data.csv", "sheet"],
    ["deck.pptx", "slides"], ["flow.drawio", "diagram"],
    ["flow.drawio.svg", "diagram"], ["flow.drawio.png", "diagram"], ["flow.drawio.xml", "diagram"],
    ["voice.mp3", "audio"], ["clip.MOV", "video"], ["backup.tar.gz", "archive"],
    ["package.json", "config"], [".env.local", "config"], [".gitignore", "config"],
    [".npmrc", "config"], ["README.md", "markdown"], ["README", "text"],
    ["server.log", "text"], ["data.sqlite", "database"],
    ["unknown.xyz", "file"], ["no-extension", "file"], [".unknown", "file"],
    ["C:\\docs\\report.pdf", "pdf"], ["folder.json/no-extension", "file"],
  ])("classifies %s as %s", (path, kind) => {
    expect(fileIconKind(path)).toBe(kind);
  });

  it("always uses a folder icon for directories, including names with extensions", () => {
    expect(fileIconKind("assets.png", true)).toBe("folder");
    const closed = renderToStaticMarkup(<DesktopFileIcon path="src" directory />);
    const open = renderToStaticMarkup(<DesktopFileIcon path="src" directory expanded />);
    expect(closed).toContain("desktop-file-icon-folder");
    expect(open).not.toEqual(closed);
  });

  it("renders distinct local SVGs and keeps decoration out of accessible filenames", () => {
    const files = ["main.ts", "logo.png", "report.pdf", "budget.xlsx", "deck.pptx", "voice.mp3", "clip.mp4", "flow.drawio", "data.sqlite"];
    const icons = files.map(path => renderToStaticMarkup(<DesktopFileIcon path={path} />));
    expect(new Set(icons).size).toBe(files.length);
    for (const icon of icons) {
      expect(icon).toContain('<svg');
      expect(icon).toContain('aria-hidden="true"');
      expect(icon).not.toContain("<img");
      expect(icon).not.toContain("http");
    }
  });
});
