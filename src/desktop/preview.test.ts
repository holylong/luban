import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createRequire } from "node:module";
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const { createWorkspace } = createRequire(import.meta.url)("../../apps/desktop/workspace.cjs");
const { mediaResponse } = createRequire(import.meta.url)("../../apps/desktop/media.cjs");
const { pptxOf } = createRequire(import.meta.url)("../../scripts/test-fixtures.cjs");

let root: string;
let service: ReturnType<typeof createWorkspace>;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "luban-preview-test-"));
  service = createWorkspace(root);
  writeFileSync(join(root, "deck.pptx"), pptxOf());
  writeFileSync(join(root, "flow.drawio"), `<mxfile><diagram name="流程"><mxGraphModel><root>
    <mxCell id="0"/><mxCell id="1" parent="0"/>
    <mxCell id="a" value="入口" style="rounded=1;" vertex="1" parent="1"><mxGeometry x="10" y="20" width="100" height="40" as="geometry"/></mxCell>
  </root></mxGraphModel></diagram></mxfile>`);
  writeFileSync(join(root, "notes.txt"), "text");
});
afterEach(() => { service.dispose(); rmSync(root, { recursive: true, force: true }); });

describe("desktop file previews", () => {
  it("parses a deck and a draw.io diagram by extension", () => {
    const deck = service.readPreview("deck.pptx");
    expect(deck).toMatchObject({ kind: "slides", path: "deck.pptx", width: 1280 });
    expect(deck.slides[0].shapes[1].lines[0].text).toBe("季度回顾");
    const diagram = service.readPreview("flow.drawio");
    expect(diagram).toMatchObject({ kind: "diagram", path: "flow.drawio" });
    expect(diagram.pages[0].nodes[0].lines).toEqual(["入口"]);
  });

  it("refuses text files and paths that escape the workspace", () => {
    expect(() => service.readPreview("notes.txt")).toThrow(/没有预览/);
    expect(() => service.readPreview("../deck.pptx")).toThrow(/Invalid workspace path/);
    expect(() => service.readPreview("missing.pptx")).toThrow();
  });

  it("streams one image entry out of the deck without unpacking it", async () => {
    const entry = service.archiveEntry("deck.pptx", "ppt/media/image1.png");
    expect(entry.type).toBe("image/png");
    expect(entry.size).toBe(16);
    expect(entry.bytes.subarray(0, 4).toString("hex")).toBe("89504e47");
    // Only image entries are exposed, and traversal names never resolve.
    expect(() => service.archiveEntry("deck.pptx", "ppt/slides/slide1.xml")).toThrow(/image/);
    expect(() => service.archiveEntry("deck.pptx", "../deck.pptx")).toThrow();

    const url = `luban-media://workspace/deck.pptx?entry=${encodeURIComponent("ppt/media/image1.png")}`;
    const response = mediaResponse(service, new Request(url));
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("image/png");
    expect(Buffer.from(await response.arrayBuffer()).subarray(0, 4).toString("hex")).toBe("89504e47");
    const partial = mediaResponse(service, new Request(url, { headers: { range: "bytes=0-3" } }));
    expect(partial.status).toBe(206);
    expect(partial.headers.get("content-range")).toBe("bytes 0-3/16");
  });

  it("resolves an absolute path only inside the workspace", () => {
    expect(service.absolutePath("deck.pptx")).toBe(join(realpathSync(root), "deck.pptx"));
    expect(() => service.absolutePath("/etc/passwd")).toThrow(/Invalid workspace path/);
  });
});
