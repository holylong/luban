import { mkdtemp, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { chromeCandidates, defaultScreenshotPath, findChrome, renderHtml } from "./render-html.js";

const chrome = findChrome();
const integration = chrome ? it : it.skip;

describe("chrome discovery", () => {
  it("takes an explicit binary first, then the platform defaults", () => {
    const candidates = chromeCandidates("darwin", { LUBAN_CHROME: "/opt/custom/chrome" });
    expect(candidates[0]).toEqual({ path: "/opt/custom/chrome", label: "LUBAN_CHROME" });
    expect(candidates.map(entry => entry.path)).toContain("/Applications/Google Chrome.app/Contents/MacOS/Google Chrome");
    expect(chromeCandidates("linux", {}).map(entry => entry.path)).toContain("/usr/bin/chromium");
    expect(chromeCandidates("win32", { PROGRAMFILES: "C:\\Program Files" }).map(entry => entry.path)).toContain("C:\\Program Files/Google/Chrome/Application/chrome.exe");
  });

  it("reports no browser instead of inventing one", () => {
    expect(findChrome("linux", { LUBAN_CHROME: "/nope/chrome" })).toBeUndefined();
  });
});

describe("screenshot destinations", () => {
  it("keeps renders in the workspace and slugs the page name", () => {
    const path = defaultScreenshotPath("/work/site/index.html", "/work");
    expect(path.startsWith("/work/.luban/render/index.html-")).toBe(true);
    expect(path.endsWith(".png")).toBe(true);
    expect(defaultScreenshotPath("https://example.com/a%20b/page.html", "/work").startsWith("/work/.luban/render/")).toBe(true);
  });
});

describe("render_html", () => {
  it("refuses a target that is neither a file nor a URL", async () => {
    await expect(renderHtml({ target: "/nope/missing.html", chrome: chrome?.path ?? "/bin/false" })).rejects.toThrow(/not a file/u);
  });

  integration("reports console errors, exceptions, failed requests and a real screenshot", async () => {
    const dir = await mkdtemp(join(tmpdir(), "luban-render-test-"));
    const page = join(dir, "scene.html");
    await writeFile(page, `<!doctype html><html><head><title>scene</title></head><body>
<canvas id="c" width="320" height="200"></canvas>
<script>
  const gl = document.getElementById('c').getContext('webgl');
  console.error('block count mismatch');
  if (!gl) console.warn('no webgl');
  fetch('http://127.0.0.1:9/missing.js').catch(() => {});
</script></body></html>`, "utf8");
    const screenshotPath = join(dir, "shot.png");
    const result = await renderHtml({ target: page, width: 400, height: 300, settleMs: 700, screenshotPath, chrome: chrome?.path });
    expect(result.title).toBe("scene");
    expect(result.canvas).toMatchObject({ count: 1, width: 320, height: 200, webgl: true });
    expect(result.consoleErrors.join(" ")).toContain("block count mismatch");
    expect(result.failedRequests.join(" ")).toContain("missing.js");
    expect(result.ok).toBe(false);
    expect(result.screenshotBytes).toBeGreaterThan(1_000);
    expect(existsSync(screenshotPath)).toBe(true);
    expect(result.pixels?.blank).toBe(true);
    expect(result.pixels?.dominantShare).toBeGreaterThan(0.9);
  }, 60_000);

  integration("describes a real scene in text, for models that cannot see the PNG", async () => {
    const dir = await mkdtemp(join(tmpdir(), "luban-render-pixels-"));
    const page = join(dir, "scene.html");
    await writeFile(page, `<!doctype html><html><head><title>scene</title></head><body style="margin:0;background:#0b1020">
<canvas id="c" width="640" height="400" style="width:640px;height:400px"></canvas>
<script>
  const context = document.getElementById('c').getContext('2d');
  context.fillStyle = '#0b1020'; context.fillRect(0, 0, 640, 400);
  for (let i = 0; i < 240; i++) {
    context.fillStyle = 'hsl(' + (i * 24) + ' 70% 60%)';
    context.fillRect(20 + (i % 20) * 30, 30 + Math.floor(i / 20) * 26, 22, 18);
  }
</script></body></html>`, "utf8");
    const result = await renderHtml({ target: page, width: 640, height: 400, settleMs: 400, screenshotPath: join(dir, "shot.png"), chrome: chrome?.path });
    const pixels = result.pixels;
    expect(pixels).toBeDefined();
    expect(pixels?.blank).toBe(false);
    expect(pixels?.distinctColors).toBeGreaterThan(4);
    expect(pixels?.ascii.split("\n")).toHaveLength(16);
    expect(pixels?.ascii.split("\n")[0]).toHaveLength(48);
    expect(pixels?.meanLuminance).toBeGreaterThan(0);
    // Colour facts, not just brightness: a blind model has to be able to say
    // "the sky is #dfeaf3 and covers half the frame".
    expect(pixels?.palette.length).toBeGreaterThan(1);
    expect(pixels?.palette[0]?.color).toMatch(/^#[0-9a-f]{6}$/u);
    expect(pixels?.palette[0]?.share).toBeGreaterThan(0);
    expect(pixels?.regions).toHaveLength(9);
    expect(pixels?.regions.map(region => region.at)).toContain("center");
    expect(pixels?.meanSaturation).toBeGreaterThan(0.1);
    expect(pixels?.warnings.some(warning => warning.kind === "blank")).toBe(false);
    // 120 small tiles are real structure, unlike a few giant flat planes.
    expect(pixels?.edgeDensity).toBeGreaterThanOrEqual(0.02);
    expect(pixels?.warnings.some(warning => warning.kind === "sparse")).toBe(false);
  }, 60_000);

  integration("says a near-white sky is washed out instead of calling it fine", async () => {
    const dir = await mkdtemp(join(tmpdir(), "luban-render-wash-"));
    const page = join(dir, "wash.html");
    await writeFile(page, `<!doctype html><html><head><title>wash</title></head>
<body style="margin:0;background:#f2f7fa">
<div style="position:absolute;left:20%;top:30%;width:32%;height:45%;background:#6f8fa8"></div>
<div style="position:absolute;left:58%;top:52%;width:18%;height:26%;background:#b9c7d2"></div>
</body></html>`, "utf8");
    const result = await renderHtml({ target: page, width: 480, height: 320, settleMs: 200, screenshotPath: join(dir, "shot.png"), chrome: chrome?.path });
    const kinds = (result.pixels?.warnings ?? []).map(warning => warning.kind);
    expect(kinds).toContain("washed-out");
    expect(result.pixels?.meanLuminance).toBeGreaterThan(200);
    expect(result.pixels?.warnings.find(warning => warning.kind === "washed-out")?.message).toMatch(/#f[0-9a-f]{5}|top third/u);
  }, 60_000);

  integration("calls a few giant flat planes sparse, not fine", async () => {
    const dir = await mkdtemp(join(tmpdir(), "luban-render-sparse-"));
    const page = join(dir, "sparse.html");
    await writeFile(page, `<!doctype html><html><head><title>sparse</title></head>
<body style="margin:0;background:#2a2440">
<div style="position:absolute;left:15%;top:35%;width:40%;height:50%;background:#6b4a3a"></div>
<div style="position:absolute;left:60%;top:55%;width:25%;height:30%;background:#3f5a4a"></div>
</body></html>`, "utf8");
    const result = await renderHtml({ target: page, width: 480, height: 320, settleMs: 200, screenshotPath: join(dir, "shot.png"), chrome: chrome?.path });
    const kinds = (result.pixels?.warnings ?? []).map(warning => warning.kind);
    expect(result.pixels?.edgeDensity).toBeLessThan(0.02);
    expect(kinds).toContain("sparse");
    // The warning has to name an action, or a blind model cannot act on it.
    expect(result.pixels?.warnings.find(warning => warning.kind === "sparse")?.message).toMatch(/torii|railing|bamboo/u);
    expect(kinds).not.toContain("washed-out");
  }, 60_000);

  integration("probe reads real scene facts out of the page", async () => {
    const dir = await mkdtemp(join(tmpdir(), "luban-render-probe-"));
    const page = join(dir, "scene.html");
    await writeFile(page, `<!doctype html><html><head><title>probe</title></head><body>
<script>
  window.scene = { children: 7, blocks: 4321 };
</script></body></html>`, "utf8");
    const ok = await renderHtml({
      target: page, width: 320, height: 200, settleMs: 150, screenshotPath: join(dir, "shot.png"),
      probe: "({ children: window.scene.children, blocks: window.scene.blocks })", chrome: chrome?.path,
    });
    expect(ok.probe).toEqual({ children: 7, blocks: 4321 });
    expect(ok.probeError).toBeUndefined();

    const bad = await renderHtml({
      target: page, width: 320, height: 200, settleMs: 150, screenshotPath: join(dir, "shot2.png"),
      probe: "window.missing.length", chrome: chrome?.path,
    });
    expect(bad.probeError).toBeTruthy();
    expect(bad.pixels).toBeDefined();
  }, 90_000);
});
