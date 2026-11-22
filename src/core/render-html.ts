import { spawn, type ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

/**
 * Headless render of a local HTML page: screenshot plus what the page actually
 * said while it ran.
 *
 * This exists because an agent asked to "check it looks right" otherwise has to
 * assemble Chrome, a DevTools client and a screenshot script out of raw bash —
 * measured at 244s of a 893s run for one voxel scene. One call returns the same
 * facts (console errors, uncaught exceptions, failed requests, canvas/WebGL
 * state, PNG path) in a few seconds.
 *
 * No dependency: Node's global WebSocket speaks CDP directly.
 */

export interface ChromeCandidate {
  path: string;
  label: string;
}

/** Chrome-family binaries worth trying, in order, for this platform. */
export function chromeCandidates(platform: NodeJS.Platform = process.platform, env: NodeJS.ProcessEnv = process.env): ChromeCandidate[] {
  const candidates: ChromeCandidate[] = [];
  if (env.LUBAN_CHROME?.trim()) candidates.push({ path: env.LUBAN_CHROME.trim(), label: "LUBAN_CHROME" });
  if (platform === "darwin") {
    candidates.push(
      { path: "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome", label: "Chrome" },
      { path: "/Applications/Chromium.app/Contents/MacOS/Chromium", label: "Chromium" },
      { path: "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge", label: "Edge" },
      { path: "/Applications/Brave Browser.app/Contents/MacOS/Brave Browser", label: "Brave" },
    );
  } else if (platform === "win32") {
    const roots = [env.PROGRAMFILES, env["PROGRAMFILES(X86)"], env.LOCALAPPDATA].filter((root): root is string => Boolean(root));
    for (const root of roots) {
      candidates.push(
        { path: join(root, "Google/Chrome/Application/chrome.exe"), label: "Chrome" },
        { path: join(root, "Microsoft/Edge/Application/msedge.exe"), label: "Edge" },
      );
    }
  } else {
    candidates.push(
      { path: "/usr/bin/google-chrome", label: "Chrome" },
      { path: "/usr/bin/google-chrome-stable", label: "Chrome stable" },
      { path: "/usr/bin/chromium", label: "Chromium" },
      { path: "/usr/bin/chromium-browser", label: "Chromium" },
      { path: "/snap/bin/chromium", label: "Chromium (snap)" },
    );
  }
  return candidates;
}

/** First installed Chrome-family binary, or undefined when there is none. */
export function findChrome(platform: NodeJS.Platform = process.platform, env: NodeJS.ProcessEnv = process.env): ChromeCandidate | undefined {
  return chromeCandidates(platform, env).find(candidate => existsSync(candidate.path));
}

export interface RenderHtmlOptions {
  /** Absolute file path, or an http(s) URL. */
  target: string;
  width?: number;
  height?: number;
  /** Extra settle time after `load`, for WebGL scenes that build asynchronously. */
  settleMs?: number;
  /** Whole-run budget; a hung page fails instead of stalling the agent. */
  timeoutMs?: number;
  /** PNG destination. Defaults to `<workspace>/.luban/render/<name>-<stamp>.png`. */
  screenshotPath?: string;
  /** JS expression evaluated in the page after it settles; its JSON value is returned. */
  probe?: string;
  chrome?: string;
  signal?: AbortSignal;
}

/** A text stand-in for the picture, for models that cannot see images. */
export interface PixelSummary {
  meanLuminance: number;
  /** Mean HSV saturation, 0–1. */
  meanSaturation: number;
  distinctColors: number;
  /** Mean neighbouring-pixel contrast, 0–1: how much structure the frame has. */
  edgeDensity: number;
  /** Share of the frame taken by its single most common colour, 0–1. */
  dominantShare: number;
  blank: boolean;
  /** Share of pixels at or near pure white / black, 0–1. */
  clippedHigh: number;
  clippedLow: number;
  /** Most common colours, largest first, as `{ color: "#rrggbb", share }`. */
  palette: { color: string; share: number }[];
  /** 3×3 grid of mean luminance and dominant colour. */
  regions: { at: string; meanLuminance: number; color: string }[];
  /** What the numbers mean, in words: blank, washed out, clipped, flat… */
  warnings: PixelWarning[];
  /** Coarse luminance map, one line per band; ` ` dark, `@` bright. */
  ascii: string;
}

export interface RenderHtmlResult {
  ok: boolean;
  url: string;
  title: string;
  screenshot: string;
  screenshotBytes: number;
  canvas: { count: number; width: number; height: number; webgl: boolean; renderer?: string };
  pixels?: PixelSummary;
  /** Whatever `probe` returned, stringified and capped. */
  probe?: unknown;
  probeError?: string;
  consoleErrors: string[];
  pageErrors: string[];
  failedRequests: string[];
  elapsedMs: number;
}

interface CdpMessage { id?: number; method?: string; params?: Record<string, unknown>; result?: Record<string, unknown>; error?: { message?: string } }

class Cdp {
  private readonly pending = new Map<number, { resolve: (value: Record<string, unknown>) => void; reject: (error: Error) => void }>();
  private nextId = 0;

  constructor(private readonly socket: WebSocket, private readonly events: CdpMessage[]) {
    socket.addEventListener("message", event => {
      const message = JSON.parse(String(event.data)) as CdpMessage;
      if (message.id !== undefined) {
        const waiter = this.pending.get(message.id);
        if (!waiter) return;
        this.pending.delete(message.id);
        if (message.error) waiter.reject(new Error(message.error.message ?? "CDP error"));
        else waiter.resolve(message.result ?? {});
        return;
      }
      if (message.method) this.events.push(message);
    });
  }

  static async connect(url: string, events: CdpMessage[]): Promise<Cdp> {
    const socket = new WebSocket(url);
    await new Promise<void>((resolveOpen, rejectOpen) => {
      socket.addEventListener("open", () => resolveOpen(), { once: true });
      socket.addEventListener("error", () => rejectOpen(new Error("could not attach to the browser's DevTools socket")), { once: true });
    });
    return new Cdp(socket, events);
  }

  send(method: string, params: Record<string, unknown> = {}): Promise<Record<string, unknown>> {
    const id = ++this.nextId;
    return new Promise((resolveSend, rejectSend) => {
      this.pending.set(id, { resolve: resolveSend, reject: rejectSend });
      this.socket.send(JSON.stringify({ id, method, params }));
    });
  }

  close(): void {
    try { this.socket.close(); } catch { /* already gone */ }
  }
}

function textOf(value: unknown): string {
  if (typeof value === "string") return value;
  if (value && typeof value === "object") {
    const item = value as { value?: unknown; description?: unknown; preview?: { description?: unknown } };
    if (typeof item.value === "string") return item.value;
    if (typeof item.description === "string") return item.description;
    if (typeof item.preview?.description === "string") return item.preview.description;
  }
  return String(value);
}

function clamp(value: number | undefined, min: number, max: number, fallback: number): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return fallback;
  return Math.min(max, Math.max(min, Math.round(value)));
}

async function waitForExit(child: ChildProcess, timeoutMs = 5_000): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  await new Promise<void>(resolveExit => {
    const timer = setTimeout(() => resolveExit(), timeoutMs);
    child.once("exit", () => { clearTimeout(timer); resolveExit(); });
  });
}

/**
 * Render `target` in headless Chrome, capture a screenshot, and report what the
 * page logged. Throws only when the render could not happen at all (no Chrome,
 * missing file); a page that throws errors still returns a result with `ok:false`.
 */
export async function renderHtml(options: RenderHtmlOptions): Promise<RenderHtmlResult> {
  const started = Date.now();
  const chrome = options.chrome ?? findChrome()?.path;
  if (!chrome) {
    throw new Error("render_html needs Chrome, Chromium, Edge or Brave installed, or LUBAN_CHROME=/path/to/binary; none was found.");
  }
  const isUrl = /^https?:\/\//iu.test(options.target);
  if (!isUrl) {
    const info = await stat(options.target).catch(() => undefined);
    if (!info?.isFile()) throw new Error(`${options.target} is not a file`);
  }
  const width = clamp(options.width, 200, 3840, 1280);
  const height = clamp(options.height, 200, 2160, 800);
  const settleMs = clamp(options.settleMs, 0, 60_000, 1_500);
  const timeoutMs = clamp(options.timeoutMs, 3_000, 180_000, 45_000);
  const profile = await mkdtemp(join(tmpdir(), "luban-render-"));
  const url = isUrl ? options.target : pathToFileURL(resolve(options.target)).href;

  let stderr = "";
  let cdp: Cdp | undefined;
  const events: CdpMessage[] = [];
  const child = spawn(chrome, [
    "--headless=new",
    "--remote-debugging-port=0",
    `--user-data-dir=${profile}`,
    "--no-first-run",
    "--no-default-browser-check",
    "--disable-background-networking",
    "--disable-extensions",
    "--hide-scrollbars",
    "--mute-audio",
    // Software GL keeps WebGL available on machines and CI boxes without a GPU.
    "--enable-unsafe-swiftshader",
    `--window-size=${width},${height}`,
    "about:blank",
  ], { stdio: ["ignore", "pipe", "pipe"] });
  const deadline = setTimeout(() => child.kill("SIGKILL"), timeoutMs);
  const aborted = () => child.kill("SIGKILL");
  options.signal?.addEventListener("abort", aborted, { once: true });
  try {
    const endpoint = await new Promise<string>((resolveEndpoint, rejectEndpoint) => {
      child.stderr?.on("data", (chunk: Buffer) => {
        stderr += chunk.toString();
        const hit = stderr.match(/DevTools listening on (ws:\/\/\S+)/u);
        if (hit) resolveEndpoint(hit[1]);
      });
      child.once("error", error => rejectEndpoint(new Error(`could not start the browser: ${error.message}`)));
      child.once("exit", code => rejectEndpoint(new Error(`the browser exited with code ${code}: ${stderr.trim().slice(-300)}`)));
      setTimeout(() => rejectEndpoint(new Error(`the browser did not open a DevTools endpoint: ${stderr.trim().slice(-300)}`)), Math.min(timeoutMs, 20_000));
    });

    // Ask for our own tab: the startup tab is not necessarily the one we can drive.
    const origin = endpoint.replace(/^ws:\/\//u, "http://").replace(/\/devtools\/browser\/.*$/u, "");
    const created = await fetch(`${origin}/json/new?about:blank`, { method: "PUT" }).then(response => response.json()).catch(() => undefined) as { webSocketDebuggerUrl?: string } | undefined;
    const pageSocket = created?.webSocketDebuggerUrl ?? await fetch(`${origin}/json/list`).then(response => response.json()).then((list: Array<{ type: string; webSocketDebuggerUrl: string }>) => list.find(entry => entry.type === "page")?.webSocketDebuggerUrl);
    if (!pageSocket) throw new Error("the browser did not expose a page target");

    cdp = await Cdp.connect(pageSocket, events);
    await cdp.send("Page.enable");
    await cdp.send("Runtime.enable");
    await cdp.send("Log.enable");
    await cdp.send("Network.enable");
    await cdp.send("Emulation.setDeviceMetricsOverride", { width, height, deviceScaleFactor: 1, mobile: false });
    await cdp.send("Page.navigate", { url });

    const loaded = new Promise<void>(resolveLoad => {
      const startedAt = Date.now();
      const poll = setInterval(() => {
        if (events.some(event => event.method === "Page.loadEventFired") || Date.now() - startedAt > Math.min(30_000, timeoutMs)) {
          clearInterval(poll);
          resolveLoad();
        }
      }, 50);
    });
    await loaded;
    if (settleMs) await new Promise(resolveSettle => setTimeout(resolveSettle, settleMs));

    const probe = await cdp.send("Runtime.evaluate", {
      expression: `(() => {
        const canvases = Array.from(document.querySelectorAll('canvas'));
        const canvas = canvases[0];
        const gl = canvas ? (canvas.getContext('webgl2') || canvas.getContext('webgl')) : null;
        let renderer;
        if (gl) {
          const info = gl.getExtension('WEBGL_debug_renderer_info');
          try { renderer = gl.getParameter(info ? info.UNMASKED_RENDERER_WEBGL : gl.RENDERER); } catch { renderer = undefined; }
        }
        return JSON.stringify({
          title: document.title || '',
          canvases: canvases.length,
          width: canvas ? canvas.width : 0,
          height: canvas ? canvas.height : 0,
          webgl: Boolean(gl),
          renderer: renderer ? String(renderer) : undefined,
        });
      })()`,
      returnByValue: true,
    });
    const page = JSON.parse(String((probe.result as { value?: unknown } | undefined)?.value ?? "{}")) as {
      title?: string; canvases?: number; width?: number; height?: number; webgl?: boolean; renderer?: string;
    };

    const shot = await cdp.send("Page.captureScreenshot", { format: "png" });
    const png = Buffer.from(String(shot.data ?? ""), "base64");
    const screenshotPath = options.screenshotPath ?? defaultScreenshotPath(options.target);
    await mkdir(dirname(screenshotPath), { recursive: true });
    await writeFile(screenshotPath, png);
    // Feed the composited frame back into the page and downscale it there: a
    // WebGL canvas often reads back blank, the screenshot never does, and this
    // needs no image library in Node.
    const pixels = await summarizePixels(cdp, png).catch(error => {
      if (process.env.LUBAN_RENDER_DEBUG) console.error("[render_html pixels]", error);
      return undefined;
    });

    const consoleErrors = events
      .filter(event => event.method === "Runtime.consoleAPICalled" && (event.params as { type?: string }).type === "error")
      .map(event => (event.params as { args?: unknown[] }).args?.map(textOf).join(" ") ?? "console.error")
      .concat(events
        .filter(event => event.method === "Log.entryAdded" && (event.params as { entry?: { level?: string } }).entry?.level === "error")
        .map(event => String((event.params as { entry?: { text?: string } }).entry?.text ?? "")))
      .filter(Boolean)
      .slice(0, 20);
    const pageErrors = events
      .filter(event => event.method === "Runtime.exceptionThrown")
      .map(event => {
        const details = (event.params as { exceptionDetails?: { text?: string; exception?: { description?: string } } }).exceptionDetails;
        return (details?.exception?.description ?? details?.text ?? "uncaught exception").split("\n")[0];
      })
      .slice(0, 20);
    const failedRequests = events
      .filter(event => event.method === "Network.loadingFailed")
      .map(event => {
        const params = event.params as { errorText?: string; requestId?: string; blockedReason?: string };
        const request = events.find(entry => entry.method === "Network.requestWillBeSent" && (entry.params as { requestId?: string }).requestId === params.requestId);
        const requestUrl = (request?.params as { request?: { url?: string } } | undefined)?.request?.url ?? params.requestId ?? "request";
        return `${params.errorText ?? params.blockedReason ?? "failed"}: ${requestUrl.slice(0, 200)}`;
      })
      .filter(entry => !/ERR_ABORTED/u.test(entry))
      .slice(0, 10);

    // A page can only be checked from inside: "how many blocks did the scene
    // actually build" is a fact the model should read, not guess from its own
    // source code.
    let probeValue: unknown;
    let probeError: string | undefined;
    if (options.probe) {
      const outcome = await cdp.send("Runtime.evaluate", {
        expression: options.probe,
        awaitPromise: true,
        returnByValue: true,
      }).catch(error => ({ error: String((error as Error).message ?? error) }) as Record<string, unknown>);
      const details = (outcome as { exceptionDetails?: { text?: string; exception?: { description?: string } } }).exceptionDetails;
      const value = (outcome.result as { value?: unknown } | undefined)?.value;
      if (details) probeError = (details.exception?.description ?? details.text ?? "probe threw").split("\n")[0];
      else if ((outcome as { error?: string }).error) probeError = (outcome as { error?: string }).error;
      else {
        const text = JSON.stringify(value ?? null) ?? "null";
        probeValue = text.length > 4_000 ? `${text.slice(0, 4_000)}… (truncated)` : value;
      }
    }

    const screenshotBytes = (await stat(screenshotPath)).size;
    return {
      ok: consoleErrors.length === 0 && pageErrors.length === 0,
      url,
      title: page.title ?? "",
      screenshot: screenshotPath,
      screenshotBytes,
      canvas: {
        count: page.canvases ?? 0,
        width: page.width ?? 0,
        height: page.height ?? 0,
        webgl: page.webgl === true,
        ...(page.renderer ? { renderer: page.renderer } : {}),
      },
      ...(pixels ? { pixels } : {}),
      ...(options.probe ? { probe: probeValue ?? null } : {}),
      ...(probeError ? { probeError } : {}),
      consoleErrors,
      pageErrors,
      failedRequests,
      elapsedMs: Date.now() - started,
    };
  } finally {
    clearTimeout(deadline);
    options.signal?.removeEventListener("abort", aborted);
    cdp?.close();
    child.kill("SIGKILL");
    await waitForExit(child);
    await rm(profile, { recursive: true, force: true }).catch(() => undefined);
  }
}

const ASCII_RAMP = " .:-=+*#%@";
/** Character grid for the ascii map: big enough to see a horizon, small enough to read. */
const ASCII_WIDTH = 48;
const ASCII_HEIGHT = 16;
/** Statistics grid: finer, because a 48x16 downscale hides thin geometry. */
const STATS_WIDTH = 96;
const STATS_HEIGHT = 54;
/** Edge density needs near-native resolution, or thin props average away. */
const EDGE_WIDTH = 480;
const EDGE_HEIGHT = 300;
/**
 * Below this mean neighbouring-pixel contrast a 3D scene reads as sparse.
 * Measured on real pages at 1440x900: thin luban pages 0.014-0.018, reference
 * scenes codex 0.022 and dsh 0.021 — the line sits just under the references
 * on purpose, so "no warning" means "as detailed as a good scene", not merely
 * "not empty".
 */
export const SPARSE_EDGE_DENSITY = 0.02;
/**
 * At or above this the frame matches the reference scenes measured here
 * (codex 0.0216-0.0220, dsh 0.0204-0.0208 across two viewports), so `thin`
 * stops firing. Keeping it just under the references means "no warning" is
 * reachable, and a `thin` warning that persists is a real gap, not a target
 * no honest scene can hit.
 */
export const RICH_EDGE_DENSITY = 0.0215;
const PALETTE_SIZE = 5;

/** Mean luminance and saturation at or beyond which a frame reads as washed out. */
export const WASHED_OUT_LUMINANCE = 170;
export const WASHED_OUT_SATURATION = 0.25;
/** Top third at or above this luminance is a near-white sky. */
export const BLOWN_SKY_LUMINANCE = 228;
/** Share of clipped pixels that means "the highlights are blown". */
export const CLIPPED_SHARE = 0.15;

export interface PixelWarning { kind: string; message: string }

type RawSummary = Omit<PixelSummary, "warnings">;

const SAMPLE_SCRIPT = `(async () => {
  const image = new Image();
  image.src = __DATA_URL__;
  await image.decode();
  const ramp = __RAMP__;
  const hex = (r, g, b) => "#" + [r, g, b].map(value => value.toString(16).padStart(2, "0")).join("");
  const canvas = document.createElement("canvas");
  const context = canvas.getContext("2d");
  if (!context) return "";
  const sample = (w, h) => {
    canvas.width = w;
    canvas.height = h;
    context.drawImage(image, 0, 0, w, h);
    return context.getImageData(0, 0, w, h).data;
  };

  // Statistics first: colours, exposure and a 3x3 layout map.
  const sw = __STATS_WIDTH__;
  const sh = __STATS_HEIGHT__;
  const data = sample(sw, sh);
  const buckets = new Map();
  let total = 0;
  let saturation = 0;
  let clippedHigh = 0;
  let clippedLow = 0;
  for (let i = 0; i < data.length; i += 4) {
    const r = data[i], g = data[i + 1], b = data[i + 2];
    const luminance = Math.round((r * 299 + g * 587 + b * 114) / 1000);
    total += luminance;
    const high = Math.max(r, g, b), low = Math.min(r, g, b);
    saturation += high === 0 ? 0 : (high - low) / high;
    if (luminance >= 245) clippedHigh++;
    if (luminance <= 10) clippedLow++;
    // 2 bits per channel: merges a sky gradient, still separates sky from tower.
    const key = (r >> 6) * 16 + (g >> 6) * 4 + (b >> 6);
    const bucket = buckets.get(key) ?? { count: 0, r: 0, g: 0, b: 0 };
    bucket.count++; bucket.r += r; bucket.g += g; bucket.b += b;
    buckets.set(key, bucket);
  }
  const count = sw * sh;
  const sorted = Array.from(buckets.values()).sort((left, right) => right.count - left.count);
  const palette = sorted.slice(0, __PALETTE__).map(bucket => ({
    color: hex(Math.round(bucket.r / bucket.count), Math.round(bucket.g / bucket.count), Math.round(bucket.b / bucket.count)),
    share: Math.round(bucket.count / count * 1000) / 1000,
  }));
  const labels = ["top-left", "top", "top-right", "left", "center", "right", "bottom-left", "bottom", "bottom-right"];
  const regions = [];
  for (let gy = 0; gy < 3; gy++) {
    for (let gx = 0; gx < 3; gx++) {
      let sum = 0, pixels = 0;
      const local = new Map();
      const y0 = Math.floor(gy * sh / 3), y1 = Math.floor((gy + 1) * sh / 3);
      const x0 = Math.floor(gx * sw / 3), x1 = Math.floor((gx + 1) * sw / 3);
      for (let y = y0; y < y1; y++) {
        for (let x = x0; x < x1; x++) {
          const i = (y * sw + x) * 4;
          sum += Math.round((data[i] * 299 + data[i + 1] * 587 + data[i + 2] * 114) / 1000);
          pixels++;
          const key = (data[i] >> 6) * 16 + (data[i + 1] >> 6) * 4 + (data[i + 2] >> 6);
          const bucket = local.get(key) ?? { count: 0, r: 0, g: 0, b: 0 };
          bucket.count++; bucket.r += data[i]; bucket.g += data[i + 1]; bucket.b += data[i + 2];
          local.set(key, bucket);
        }
      }
      const top = Array.from(local.values()).sort((left, right) => right.count - left.count)[0];
      regions.push({
        at: labels[gy * 3 + gx],
        meanLuminance: pixels ? Math.round(sum / pixels) : 0,
        color: top ? hex(Math.round(top.r / top.count), Math.round(top.g / top.count), Math.round(top.b / top.count)) : "#000000",
      });
    }
  }

  // Then the readable map, on its own coarser grid.
  const aw = __ASCII_WIDTH__;
  const ah = __ASCII_HEIGHT__;
  const small = sample(aw, ah);
  const rows = [];
  for (let y = 0; y < ah; y++) {
    let row = "";
    for (let x = 0; x < aw; x++) {
      const i = (y * aw + x) * 4;
      const luminance = Math.round((small[i] * 299 + small[i + 1] * 587 + small[i + 2] * 114) / 1000);
      row += ramp[Math.min(ramp.length - 1, Math.floor(luminance * ramp.length / 256))];
    }
    rows.push(row);
  }
  // Edge density at full sampling resolution: the honest "is there stuff in
  // this picture" metric. Colour count and brightness both pass a scene of
  // three giant flat planes, but a detailed one has far more pixel contrast,
  // and the gap only shows up when the sample is not downscaled to 96x54.
  const ew = __EDGE_WIDTH__;
  const eh = __EDGE_HEIGHT__;
  const detail = sample(ew, eh);
  const detailLum = new Float64Array(ew * eh);
  for (let i = 0, j = 0; i < detail.length; i += 4, j++) {
    detailLum[j] = (detail[i] * 299 + detail[i + 1] * 587 + detail[i + 2] * 114) / 1000;
  }
  let gradient = 0;
  for (let y = 0; y < eh; y++) {
    for (let x = 0; x < ew; x++) {
      const i = y * ew + x;
      if (x + 1 < ew) gradient += Math.abs(detailLum[i] - detailLum[i + 1]);
      if (y + 1 < eh) gradient += Math.abs(detailLum[i] - detailLum[i + ew]);
    }
  }
  const edgeDensity = Math.round(gradient / (ew * eh * 2 * 255) * 10000) / 10000;
  const dominantShare = (sorted[0] ? sorted[0].count : 0) / count;
  return JSON.stringify({
    meanLuminance: Math.round(total / count),
    meanSaturation: Math.round(saturation / count * 100) / 100,
    distinctColors: buckets.size,
    edgeDensity,
    dominantShare: Math.round(dominantShare * 1000) / 1000,
    blank: dominantShare > 0.97 && buckets.size <= 4,
    clippedHigh: Math.round(clippedHigh / count * 1000) / 1000,
    clippedLow: Math.round(clippedLow / count * 1000) / 1000,
    palette,
    regions,
    ascii: rows.join("\\n"),
  });
})()`;

/**
 * Downscale the captured frame inside the page and describe it in words and
 * numbers: a model without vision should be able to say "the sky is #dfeaf3,
 * the frame is washed out, the tower is dark and centred" — not upload a PNG.
 */
async function summarizePixels(cdp: Cdp, png: Buffer): Promise<PixelSummary | undefined> {
  const dataUrl = `data:image/png;base64,${png.toString("base64")}`;
  const expression = SAMPLE_SCRIPT
    .replace("__DATA_URL__", JSON.stringify(dataUrl))
    .replace("__RAMP__", JSON.stringify(ASCII_RAMP))
    .replace("__PALETTE__", String(PALETTE_SIZE))
    .replace("__STATS_WIDTH__", String(STATS_WIDTH))
    .replace("__STATS_HEIGHT__", String(STATS_HEIGHT))
    .replace("__ASCII_WIDTH__", String(ASCII_WIDTH))
    .replace("__ASCII_HEIGHT__", String(ASCII_HEIGHT))
    .replace("__EDGE_WIDTH__", String(EDGE_WIDTH))
    .replace("__EDGE_HEIGHT__", String(EDGE_HEIGHT));
  const evaluated = await cdp.send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true });
  const value = (evaluated.result as { value?: unknown } | undefined)?.value;
  if (typeof value !== "string" || !value) return undefined;
  const raw = JSON.parse(value) as RawSummary;
  return { ...raw, warnings: pixelWarnings(raw) };
}

/** Turn the numbers into the sentence a blind model would have written itself. */
function pixelWarnings(summary: RawSummary): PixelWarning[] {
  const warnings: PixelWarning[] = [];
  if (summary.blank) {
    warnings.push({ kind: "blank", message: "The frame is one flat colour — nothing (or nothing visible) was drawn." });
    return warnings;
  }
  const sky = summary.regions?.find(region => region.at === "top");
  const skyIsWhite = Boolean(sky && sky.meanLuminance >= BLOWN_SKY_LUMINANCE);
  if (skyIsWhite || (summary.meanLuminance >= WASHED_OUT_LUMINANCE && summary.meanSaturation < WASHED_OUT_SATURATION)) {
    warnings.push({
      kind: "washed-out",
      message: `Frame average ${summary.meanLuminance}/255 with saturation ${summary.meanSaturation}${sky ? `; the top band averages ${sky.meanLuminance}/255 mostly ${sky.color}` : ""}. The background is near-white, so every silhouette loses contrast. Darken sky/fog (a dusk palette near #1a1430 or #2a2440) and let the lighting come from one strong key light instead of brightening materials.`,
    });
  }
  if ((summary.clippedHigh ?? 0) >= CLIPPED_SHARE) {
    warnings.push({ kind: "clipped", message: `${Math.round((summary.clippedHigh ?? 0) * 100)}% of pixels are at or near pure white — exposure or light intensity is too high.` });
  }
  if (summary.meanSaturation < 0.12) {
    warnings.push({ kind: "desaturated", message: `Mean saturation ${summary.meanSaturation} is nearly grey: add hue variety or raise material saturation.` });
  }
  const top = summary.palette?.[0];
  if (top && top.share > 0.5) {
    warnings.push({ kind: "flat", message: `${Math.round(top.share * 100)}% of the frame is a single colour (${top.color}) — background dominates the composition.` });
  }
  const edge = summary.edgeDensity ?? 1;
  if (edge < SPARSE_EDGE_DENSITY) {
    warnings.push({
      kind: "sparse",
      message: `Edge density ${edge} against 0.021-0.022 for a polished scene of this size: the frame is mostly smooth, so it reads as a few large shapes. Add objects with their own silhouettes (railing, rocks, torii, lanterns, bamboo, statues, birds, boats) and vary their heights, but if the number keeps climbing slowly, change composition instead — move the camera closer, put layered background (hills, distant trees, clouds) behind the subject, use a finer voxel grid so surfaces carry their own steps, and spread ground scatter under everything. A scene is not finished while this warning shows.`,
    });
  } else if (edge < RICH_EDGE_DENSITY) {
    warnings.push({
      kind: "thin",
      message: `Edge density ${edge} is acceptable but thinner than a polished scene (0.0216-0.022): the shapes are readable, the surface detail is not. Finer voxels, trim on edges and a busier background are what close this gap — do not stop at "no warnings".`,
    });
  }
  return warnings;
}

/** `<workspace>/.luban/render/<name>-<stamp>.png` */
export function defaultScreenshotPath(target: string, workspace?: string): string {
  const slug = basename(target.replace(/[?#].*$/u, ""))
    .replace(/[^a-z0-9._-]+/giu, "-")
    .replace(/^-+|-+$/gu, "")
    .slice(0, 60) || "page";
  const stamp = new Date().toISOString().replace(/[:.]/gu, "-").slice(0, 19);
  const root = workspace ?? (isAbsolute(target) ? dirname(target) : process.cwd());
  return join(root, ".luban", "render", `${slug}-${stamp}.png`);
}

