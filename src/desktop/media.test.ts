import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createRequire } from "node:module";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const { createWorkspace } = createRequire(import.meta.url)("../../apps/desktop/workspace.cjs");
const { mediaResponse } = createRequire(import.meta.url)("../../apps/desktop/media.cjs");

let root: string;
let service: ReturnType<typeof createWorkspace>;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "luban-media-test-"));
  service = createWorkspace(root);
  writeFileSync(join(root, "clip.mp4"), Buffer.from("0123456789"));
  writeFileSync(join(root, "empty.mp3"), Buffer.alloc(0));
  writeFileSync(join(root, "notes.txt"), "text");
  writeFileSync(join(root, "report.pdf"), "%PDF-1.4");
});
afterEach(() => { service.dispose(); rmSync(root, { recursive: true, force: true }); });

const url = (path: string) => `luban-media://workspace/${path}`;
const get = (path: string, range?: string, method = "GET") =>
  mediaResponse(service, new Request(url(path), { method, headers: range ? { range } : {} }));

describe("luban-media:// responses", () => {
  it("serves a whole media file with its type", async () => {
    const response = get("clip.mp4");
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("video/mp4");
    expect(response.headers.get("accept-ranges")).toBe("bytes");
    expect(response.headers.get("content-length")).toBe("10");
    expect(await response.text()).toBe("0123456789");
  });

  it("answers range requests so video can seek", async () => {
    const part = get("clip.mp4", "bytes=2-5");
    expect(part.status).toBe(206);
    expect(part.headers.get("content-range")).toBe("bytes 2-5/10");
    expect(part.headers.get("content-length")).toBe("4");
    expect(await part.text()).toBe("2345");
    const open = get("clip.mp4", "bytes=6-");
    expect(open.headers.get("content-range")).toBe("bytes 6-9/10");
    expect(await open.text()).toBe("6789");
  });

  it("rejects a range past the end, non-media paths and a closed workspace", () => {
    expect(get("clip.mp4", "bytes=40-50").status).toBe(416);
    expect(get("notes.txt").status).toBe(404);
    expect(get("missing.mp4").status).toBe(404);
    expect(mediaResponse(undefined, new Request(url("clip.mp4"))).status).toBe(503);
  });

  it("serves a PDF with the type the embedded viewer needs", async () => {
    const response = get("report.pdf");
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("application/pdf");
    expect(await response.text()).toBe("%PDF-1.4");
  });

  it("answers HEAD and an empty file without a body", () => {
    const head = get("clip.mp4", undefined, "HEAD");
    expect(head.status).toBe(200);
    expect(head.headers.get("content-length")).toBe("10");
    expect(head.body).toBeNull();
    const empty = get("empty.mp3");
    expect(empty.status).toBe(200);
    expect(empty.headers.get("content-length")).toBe("0");
    expect(empty.body).toBeNull();
  });
});
