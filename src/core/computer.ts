import { chmod, mkdir, readdir, readFile, rename, stat, unlink, writeFile } from "node:fs/promises";
import { spawn, type ChildProcess } from "node:child_process";
import { createHash } from "node:crypto";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { existsSync } from "node:fs";

/**
 * Computer control: the one place that can move the pointer, type and capture the
 * screen. Everything funnels through the compiled Swift helper, because a Node
 * process cannot post CGEvents, and the helper is also what carries the macOS
 * Accessibility and Screen Recording permissions.
 *
 * Two rules hold everywhere:
 *  1. Nothing runs unless a human opened a control session (the Agent panel's
 *     「电脑操控」switch). A closed session is an error, not a silent no-op.
 *  2. A session can be stopped from the desktop edge glow (⌘.), and each action
 *     re-reads the stop flag, so a runaway loop cannot outlive the abort key.
 */

export interface ComputerPermissions {
  helper: string;
  accessible: boolean;
  /** macOS will accept synthetic clicks/keys (TCC post-event grant). */
  postEvent: boolean;
  screenRecording: boolean;
  displayScale: number;
}

export interface HelperReply {
  ok: boolean;
  error?: string;
  [key: string]: unknown;
}

export interface ComputerRequest {
  x?: number;
  y?: number;
  text?: string;
  key?: string;
  modifiers?: string[];
  /** App name for the `app` action: launch it, or raise it if it is running. */
  name?: string;
  /** URL for the `open` action. */
  url?: string;
  button?: string;
  count?: number;
  dy?: number;
  dx?: number;
  region?: { x: number; y: number; width: number; height: number };
  from?: { x: number; y: number };
  to?: { x: number; y: number };
}

export interface ComputerOptions {
  /** ~/.luban by default; keeps the helper, stop flag and shots together. */
  home?: string;
  /** Screenshots land here so the model can attach them. */
  workspace?: string;
  /** Overrides the compiled helper (tests point this at a fake binary). */
  helper?: string;
  /** Called for begin/action/end so the desktop can light and clear the edge glow. */
  notify?(event: ComputerEvent): void;
  /** Abort hook shared with the rest of the agent. */
  signal?: AbortSignal;
}

export interface ComputerEvent {
  event: "begin" | "action" | "end";
  action?: string;
  label?: string;
}

// The source and a prebuilt binary live in the desktop app's native folder. A
// packaged macOS app keeps that folder at <app>/desktop/native (no apps/ prefix),
// so both layouts are searched instead of guessing from the install root.
const NATIVE_RELATIVES = [
  join("apps", "desktop", "native"),
  join("desktop", "native"),
];
const SOURCE_NAME = "computer.swift";

// The tool names the actions the way the model reads them; the helper does not
// use underscores in its switch, so one table keeps both vocabularies honest.
const HELPER_ACTIONS: Record<string, string> = {
  double_click: "doubleclick",
  right_click: "rightclick",
};
const BINARY_NAME = "luban-computer";
// The overlay that draws the rim for terminal runs (see glow.swift).
const GLOW_SOURCE_NAME = "glow.swift";
const GLOW_BINARY_NAME = "luban-glow";

/** `{width,height}` out of a loose helper field, or undefined when unusable. */
function sizeOf(value: unknown): { width: number; height: number } | undefined {
  if (!value || typeof value !== "object") return undefined;
  const record = value as { width?: unknown; height?: unknown };
  const width = Number(record.width);
  const height = Number(record.height);
  if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) return undefined;
  return { width: Math.round(width), height: Math.round(height) };
}

export function computerHome(options: ComputerOptions = {}): string {
  return resolve(options.home ?? process.env.LUBAN_HOME ?? join(homedir(), ".luban"));
}

/** Where the compiled helper and the session bookkeeping live. */
function stateDir(home: string): string {
  return join(home, "computer");
}

function stopPath(home: string): string {
  return join(stateDir(home), "stop");
}

/**
 * Find computer.swift after a build: dist/core/computer.js sits two levels below
 * the repository root, so walk up looking for the source before giving up.
 */
function nativeCandidate(name: string): string | undefined {
  const roots = [dirname(fileURLToPath(import.meta.url)), process.cwd()];
  for (const root of roots) {
    let directory = root;
    for (let depth = 0; depth < 6; depth += 1) {
      for (const relative of NATIVE_RELATIVES) {
        const candidate = join(directory, relative, name);
        if (existsSync(candidate)) return candidate;
      }
      const parent = dirname(directory);
      if (parent === directory) break;
      directory = parent;
    }
  }
  return undefined;
}

export function helperSource(): string | undefined {
  const override = process.env.LUBAN_COMPUTER_SOURCE;
  if (override) return existsSync(override) ? override : undefined;
  return nativeCandidate(SOURCE_NAME);
}

function run(command: string, args: string[], options: { input?: string; timeout?: number; signal?: AbortSignal } = {}): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((done, fail) => {
    const child = spawn(command, args, { stdio: ["pipe", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    let settled = false;
    const finish = (code: number | null): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      done({ code, stdout, stderr });
    };
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      if (!settled) {
        settled = true;
        fail(new Error(`${command} timed out after ${options.timeout ?? 30_000}ms`));
      }
    }, options.timeout ?? 30_000);
    child.stdout.on("data", chunk => { stdout += String(chunk); });
    child.stderr.on("data", chunk => { stderr += String(chunk); });
    child.on("error", cause => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      fail(cause);
    });
    child.on("close", code => finish(code));
    options.signal?.addEventListener("abort", () => { child.kill("SIGKILL"); finish(null); }, { once: true });
    child.stdin.end(options.input ?? "");
  });
}

/**
 * Compile the helper once per source revision. `swiftc` ships with the Xcode
 * command line tools; without them the error says exactly what to install
 * instead of reporting a missing binary.
 */
/** Compile one native source by content hash, reusing the build across runs. */
async function compileSwift(home: string, source: string, name: string): Promise<string> {
  const text = await readFile(source, "utf8");
  const tag = createHash("sha256").update(text).digest("hex").slice(0, 10);
  const binary = join(home, "bin", `${name}-${tag}`);
  if (existsSync(binary)) return binary;
  await mkdir(dirname(binary), { recursive: true });
  await mkdir(stateDir(home), { recursive: true });
  const scratch = `${binary}.tmp-${process.pid}`;
  const built = await run("swiftc", ["-O", source, "-o", scratch], { timeout: 180_000 });
  if (built.code !== 0 || !existsSync(scratch)) {
    const reason = built.stderr.trim().split("\n").slice(0, 3).join(" / ") || `swiftc exited ${built.code}`;
    throw new Error(`编译 ${name} 失败：${reason}。需要 Xcode 命令行工具（xcode-select --install）。`);
  }
  await chmod(scratch, 0o755);
  // Concurrent callers may race here; a rename onto an identical build is fine.
  await rename(scratch, binary).catch(async () => { await unlink(scratch).catch(() => undefined); });
  if (!existsSync(binary)) throw new Error(`编译 ${name} 失败：${scratch} 未生成`);
  return binary;
}

export async function ensureHelper(home: string): Promise<string> {
  const override = process.env.LUBAN_COMPUTER_HELPER;
  if (override) {
    if (!existsSync(override)) throw new Error(`LUBAN_COMPUTER_HELPER 指向的 helper 不存在：${override}`);
    return override;
  }
  // A packaged build may ship the compiled helper, which skips swiftc entirely
  // and works on a Mac without the Xcode command line tools.
  const prebuilt = process.env.LUBAN_COMPUTER_SOURCE ? undefined : nativeCandidate(BINARY_NAME);
  if (prebuilt) return prebuilt;
  const source = helperSource();
  if (!source) throw new Error("找不到 computer.swift：电脑操控 helper 源码缺失（apps/desktop/native/computer.swift）");
  return compileSwift(home, source, BINARY_NAME);
}

/** The CLI rim: a native overlay because a terminal cannot paint over apps. */
export async function ensureGlow(home: string): Promise<string> {
  const override = process.env.LUBAN_GLOW_BINARY;
  if (override) {
    if (!existsSync(override)) throw new Error(`LUBAN_GLOW_BINARY 指向的 glow 不存在：${override}`);
    return override;
  }
  const prebuilt = nativeCandidate(GLOW_BINARY_NAME);
  if (prebuilt) return prebuilt;
  const source = nativeCandidate(GLOW_SOURCE_NAME);
  if (!source) throw new Error("找不到 glow.swift：电脑操控燃弧源码缺失（apps/desktop/native/glow.swift）");
  return compileSwift(home, source, GLOW_BINARY_NAME);
}

/** One request in, one reply out. The helper reads JSON lines on stdin. */
export async function helperCall(helper: string, request: Record<string, unknown>, signal?: AbortSignal): Promise<HelperReply> {
  const reply = await run(helper, [], { input: `${JSON.stringify(request)}\n`, timeout: 20_000, signal });
  const line = reply.stdout.split("\n").map(part => part.trim()).filter(Boolean).pop();
  if (!line) {
    throw new Error(reply.stderr.trim() || `电脑操控 helper 没有返回结果（exit ${reply.code}）`);
  }
  const parsed = JSON.parse(line) as HelperReply;
  if (!parsed.ok) throw new Error(String(parsed.error ?? "电脑操控失败"));
  return parsed;
}

/**
 * Synthetic input is written against macOS AppKit/CoreGraphics. Linux and
 * Windows keep every other luban feature; they just have no input backend yet.
 */
export function computerSupported(platform: string = process.platform): boolean {
  return platform === "darwin";
}

const UNSUPPORTED = (platform: string): string =>
  `电脑操控目前只支持 macOS（当前是 ${platform}）。截图、指针与键盘注入都走 macOS 原生 API，其他平台还没有等效实现。`;

export async function checkPermissions(home: string): Promise<ComputerPermissions> {
  if (!computerSupported()) throw new Error(UNSUPPORTED(process.platform));
  const helper = await ensureHelper(home);
  const reply = await helperCall(helper, { action: "check" });
  return {
    helper,
    accessible: reply.accessibility === true,
    postEvent: reply.postEvent === true,
    screenRecording: reply.screenRecording === true,
    displayScale: Number(reply.displayScale ?? 1) || 1,
  };
}

/**
 * A control session. The desktop switch calls begin()/end(); the agent's tool
 * calls act(). Stop arrives from the ⌘. shortcut as a file so the backend — a
 * separate process — sees it without an IPC round trip.
 */
export class ComputerControl {
  private readonly home: string;
  private readonly workspace?: string;
  private readonly notify?: (event: ComputerEvent) => void;
  private active = false;
  private since = 0;
  /** The native rim process while a session is open (terminal runs). */
  private rim?: ChildProcess;

  constructor(options: ComputerOptions = {}) {
    this.home = computerHome(options);
    this.workspace = options.workspace;
    this.notify = options.notify;
  }

  get enabled(): boolean {
    // The stop flag is shared with the desktop process, so the switch reads off
    // within one poll even though ⌘. never talks to this process directly.
    return this.active && !existsSync(stopPath(this.home));
  }

  get startedAt(): number {
    return this.since;
  }

  async begin(label?: string): Promise<void> {
    if (!computerSupported()) throw new Error(UNSUPPORTED(process.platform));
    await mkdir(stateDir(this.home), { recursive: true });
    await unlink(stopPath(this.home)).catch(() => undefined);
    this.active = true;
    this.since = Date.now();
    this.notify?.({ event: "begin", label });
    void this.startRim(label);
  }

  /** Exposed for tests and status: the overlay is a child process we own. */
  get rimPid(): number | undefined {
    return this.rim?.pid;
  }

  /**
   * Whether this process should draw the rim itself. The desktop app already
   * runs an overlay and hands us LUBAN_GLOW_URL to post events to, so drawing a
   * second one would double the light; LUBAN_GLOW=off turns it off everywhere.
   */
  private rimAllowed(): boolean {
    if (process.platform !== "darwin") return false;
    if ((process.env.LUBAN_GLOW ?? "").toLowerCase() === "off") return false;
    return !process.env.LUBAN_GLOW_URL;
  }

  private async startRim(label?: string): Promise<void> {
    if (!this.rimAllowed() || this.rim) return;
    try {
      const binary = await ensureGlow(this.home);
      if (!this.active) return; // stopped while swiftc was running
      const child = spawn(binary, [
        "--label", label || "luban 正在操控",
        "--stop-file", stopPath(this.home),
        "--parent-pid", String(process.pid),
        "--timeout", String(8 * 60 * 60),
      ], { stdio: "ignore" });
      child.on("error", () => { if (this.rim === child) this.rim = undefined; });
      child.on("exit", () => { if (this.rim === child) this.rim = undefined; });
      this.rim = child;
    } catch {
      // The rim is a signal, not a capability: never block control over it.
    }
  }

  /**
   * Close the overlay and wait for it to go. The glow writes the stop flag on
   * SIGTERM (so a vanished backend aborts the next action), which means the
   * caller must delete the flag *after* this resolves or a normal close would
   * look like a human abort.
   */
  private async stopRim(): Promise<void> {
    const child = this.rim;
    this.rim = undefined;
    if (!child || child.killed) return;
    const exited = new Promise<void>(resolve => child.once("exit", () => resolve()));
    child.kill("SIGTERM");
    await Promise.race([exited, new Promise<void>(resolve => setTimeout(resolve, 1500))]);
  }

  /** Human pressed stop (⌘.) or the switch was turned off. */
  async end(): Promise<void> {
    if (!this.active) {
      await unlink(stopPath(this.home)).catch(() => undefined);
      return;
    }
    this.active = false;
    await this.stopRim();
    this.notify?.({ event: "end" });
    await unlink(stopPath(this.home)).catch(() => undefined);
  }

  /** Recorded by the desktop app so the next action aborts even mid-script. */
  async requestStop(): Promise<void> {
    this.active = false;
    await this.stopRim();
    await mkdir(stateDir(this.home), { recursive: true });
    await writeFile(stopPath(this.home), String(Date.now()));
    this.notify?.({ event: "end", label: "stopped" });
  }

  private async ensureRunning(): Promise<void> {
    if (!computerSupported()) throw new Error(UNSUPPORTED(process.platform));
    // The stop flag wins: after ⌘. the honest reason is that the human aborted,
    // not that the switch was never on.
    if (existsSync(stopPath(this.home))) {
      this.active = false;
      throw new Error("用户已中止电脑操控（⌘.）。请让用户重新开启开关后再操作。");
    }
    if (!this.active) {
      throw new Error("电脑操控未开启：请先在 luban 界面打开「电脑操控」开关；终端 TUI 可运行 /computer on，然后重试。");
    }
  }

  /** Capture the screen (or a region) into the workspace so it can be attached. */
  async screenshot(region?: ComputerRequest["region"]): Promise<{
    path: string;
    bytes: number;
    region?: ComputerRequest["region"];
    /** Screenshot size in pixels; `points` is what clicks use, so say both. */
    pixels?: { width: number; height: number };
    points?: { width: number; height: number };
    scale?: number;
  }> {
    await this.ensureRunning();
    const helper = await ensureHelper(this.home);
    const directory = join(this.workspace ?? this.home, this.workspace ? join(".luban", "computer") : "computer");
    await mkdir(directory, { recursive: true });
    const path = join(directory, `shot-${new Date().toISOString().replace(/[:.]/gu, "-")}.png`);
    const reply = await helperCall(helper, { action: "screenshot", path, region });
    this.notify?.({ event: "action", action: "screenshot" });
    await this.prune(directory);
    const pixels = sizeOf(reply.pixels);
    const screen = (reply.screen ?? {}) as { width?: unknown; height?: unknown; scale?: unknown };
    const points = region
      ? { width: Math.round(region.width), height: Math.round(region.height) }
      : sizeOf(screen);
    return {
      path,
      bytes: Number(reply.bytes ?? 0),
      region,
      ...(pixels ? { pixels } : {}),
      ...(points ? { points } : {}),
      ...(Number.isFinite(Number(screen.scale)) ? { scale: Number(screen.scale) } : {}),
    };
  }

  /** Frontmost app, every on-screen window and the screen size, all in points. */
  async windows(): Promise<{
    front?: { name?: string; bundle?: string; pid?: number };
    windows: Array<{ app: string; title: string; x: number; y: number; width: number; height: number }>;
    screen?: { width: number; height: number; scale: number };
  }> {
    await this.ensureRunning();
    const helper = await ensureHelper(this.home);
    const reply = await helperCall(helper, { action: "windows" });
    this.notify?.({ event: "action", action: "windows" });
    const rows = Array.isArray(reply.windows) ? reply.windows : [];
    return {
      front: (reply.front ?? {}) as { name?: string; bundle?: string; pid?: number },
      windows: rows.map(row => {
        const item = (row ?? {}) as Record<string, unknown>;
        return {
          app: String(item.app ?? ""),
          title: String(item.title ?? ""),
          x: Math.round(Number(item.x ?? 0)),
          y: Math.round(Number(item.y ?? 0)),
          width: Math.round(Number(item.width ?? 0)),
          height: Math.round(Number(item.height ?? 0)),
        };
      }),
      ...(sizeOf(reply.screen) ? { screen: reply.screen as { width: number; height: number; scale: number } } : {}),
    };
  }

  private async prune(directory: string): Promise<void> {
    // A screenshot per step adds up fast; keep the last 20.
    const entries = await readdir(directory).catch(() => [] as string[]);
    const shots = entries.filter(name => /^shot-.*\.png$/u.test(name)).sort();
    for (const name of shots.slice(0, Math.max(0, shots.length - 20))) {
      await unlink(join(directory, name)).catch(() => undefined);
    }
  }

  async act(action: string, request: ComputerRequest = {}, options: ComputerOptions = {}): Promise<{ summary: string; reply: HelperReply }> {
    if (action === "screenshot") {
      const shot = await this.screenshot(request.region);
      return {
        summary: `已截屏 ${shot.path}（${shot.bytes} 字节${shot.region ? `，区域 ${shot.region.width}×${shot.region.height}` : "，全屏"}${shot.points ? `，屏幕 ${shot.points.width}×${shot.points.height} 点` : ""}）`,
        reply: {
          ok: true, path: shot.path, bytes: shot.bytes,
          ...(shot.pixels ? { pixels: shot.pixels } : {}),
          ...(shot.points ? { screen: { ...shot.points, scale: shot.scale ?? 1 } } : {}),
        },
      };
    }
    if (action === "status") {
      const permissions = await checkPermissions(this.home);
      return { summary: "", reply: { ok: true, ...permissions } };
    }
    await this.ensureRunning();
    const helper = await ensureHelper(this.home);
    const target = HELPER_ACTIONS[action] ?? action;
    const payload: Record<string, unknown> = { action: target };
    for (const [key, value] of Object.entries(request)) if (value !== undefined) payload[key] = value;
    const reply = await helperCall(helper, payload, options.signal);
    this.notify?.({ event: "action", action });
    return { summary: this.describe(action, request, reply), reply };
  }

  private describe(action: string, request: ComputerRequest, reply: HelperReply): string {
    const at = (x?: number, y?: number): string => (typeof x === "number" && typeof y === "number" ? ` (${Math.round(x)}, ${Math.round(y)})` : "");
    switch (action) {
      case "move": return `指针移动到${at(request.x, request.y)}`;
      case "click": return `点击${at(request.x, request.y)}${request.button === "right" ? "（右键）" : ""}`;
      case "double_click": return `双击${at(request.x, request.y)}`;
      case "right_click": return `右键点击${at(request.x, request.y)}`;
      case "drag": return `拖拽 ${at(request.from?.x, request.from?.y)} → ${at(request.to?.x, request.to?.y)}`;
      case "scroll": return `滚轮 dy=${request.dy ?? 0} dx=${request.dx ?? 0}`;
      case "type": return `输入 ${JSON.stringify((request.text ?? "").slice(0, 60))}`;
      case "key": return `按键 ${[...(request.modifiers ?? []), request.key].filter(Boolean).join("+")}`;
      case "cursor": return `指针位置${at(Number(reply.x), Number(reply.y))}`;
      case "app": return `打开 ${String(request.name ?? "应用")}`;
      case "windows": return "查看屏幕上的窗口";
      default: return action;
    }
  }
}

/**
 * The desktop app hands the backend a loopback glow endpoint, so lighting the
 * edge glow never needs IPC across two processes: the same event that starts a
 * session posts to it, and a failed post is never worth blocking an action for.
 */
export function glowNotifier(env: NodeJS.ProcessEnv = process.env): ((event: ComputerEvent) => void) | undefined {
  const url = env.LUBAN_GLOW_URL;
  if (!url) return undefined;
  const token = env.LUBAN_GLOW_TOKEN ?? "";
  return event => {
    void fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json", "x-luban-glow-token": token },
      body: JSON.stringify(event),
      signal: AbortSignal.timeout(1200),
    }).catch(() => undefined);
  };
}

/** Process-wide session shared by the agent tool and the /api/computer endpoint. */
let session: ComputerControl | undefined;
let sessionKey = "";

export function computerControl(options: ComputerOptions = {}): ComputerControl {
  const home = computerHome(options);
  const key = `${home}\u0000${options.workspace ?? ""}`;
  // One backend serves one workspace, so a different key means a different run.
  if (!session || (sessionKey !== key && !session.enabled)) {
    session = new ComputerControl({ ...options, home, notify: options.notify ?? glowNotifier() });
    sessionKey = key;
  }
  return session;
}

/**
 * Headless opt-in. `luban --prompt` and piped stdin have no switch to click, so
 * `LUBAN_COMPUTER=1` is the human saying "yes, this run may drive the desktop".
 * Unset uses the supplied trusted default (false for legacy callers); 0/no disables.
 */
export async function beginFromEnvironment(home: string, workspace: string, env: NodeJS.ProcessEnv = process.env, defaultEnabled = false): Promise<boolean> {
  const flag = env.LUBAN_COMPUTER?.trim();
  if (flag ? !/^(1|on|true|yes)$/iu.test(flag) : !defaultEnabled) return false;
  // A headless run on Linux/Windows must not die over an unsupported feature.
  if (!computerSupported()) {
    process.stderr.write(`${UNSUPPORTED(process.platform)}已忽略 LUBAN_COMPUTER。\n`);
    return false;
  }
  await computerControl({ home, workspace }).begin("环境变量 LUBAN_COMPUTER");
  return true;
}

const startupHomes = new Set<string>();

/** Initialize once per home; later entry points cannot undo a manual off/stop. */
export async function beginComputerAtStartup(home: string, workspace: string, enabled = true, env: NodeJS.ProcessEnv = process.env): Promise<boolean> {
  const key = resolve(home);
  if (startupHomes.has(key)) return computerControl({ home, workspace }).enabled;
  startupHomes.add(key);
  if (existsSync(stopPath(home))) return false;
  try {
    return await beginFromEnvironment(home, workspace, env, enabled);
  } catch (error) {
    process.stderr.write(`电脑操控启动失败：${error instanceof Error ? error.message : String(error)}\n`);
    return false;
  }
}

export function resetComputerControlForTests(): void {
  startupHomes.clear();
  session = undefined;
  sessionKey = "";
}

/** Absolute age of a file, used by tests and the status line. */
export async function fileAge(path: string): Promise<number | undefined> {
  const info = await stat(path).catch(() => undefined);
  return info ? Date.now() - info.mtimeMs : undefined;
}
