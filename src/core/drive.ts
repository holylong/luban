/* A control session: the thing the 造物主 window is actually for.
 *
 * `luban bot` is a queue of *unattended* jobs — deny-by-default, one prompt in,
 * one Markdown answer out, no way to answer a permission question mid-run. That
 * shape cannot drive a computer: the model has to look at the screen, click, and
 * be allowed to do so *now*, while someone is watching.
 *
 * So a drive session is deliberately a different animal:
 *
 *  - it is a conversation, not a job: every `say` appends to the same message
 *    list, and the next turn remembers what the last one saw;
 *  - every action is announced before it happens (`tool` events carry a Chinese
 *    label like `点击 720,430`), so the window can show a live timeline instead
 *    of a spinner;
 *  - read-only work (截图 / 读光标 / 读文件) runs without interruption, while
 *    anything that changes the screen or the disk raises an `approval` event and
 *    waits for the window. The default is deny, including on timeout.
 *
 * The runner is injectable so the policy above can be tested without a model.
 */

import { randomUUID } from "node:crypto";
import { AgentRunner, initialMessages } from "./agent.js";
import { beginFromEnvironment, checkPermissions, computerControl, computerSupported } from "./computer.js";
import { loadConfig } from "./config.js";
import type { AgentEvent, ChatMessage, LubanConfig } from "./types.js";
import type { DriveComputerState, DriveEvent, DriveUsage } from "./drive-events.js";

export type { DriveCommand, DriveComputerState, DriveEvent, DriveUsage } from "./drive-events.js";

/** The slice of AgentRunner a session uses; tests substitute a scripted one. */
export interface DriveRunner {
  run(
    messages: ChatMessage[],
    mode: "agent" | "plan",
    signal: AbortSignal,
    onEvent: (event: AgentEvent) => void,
    approve: (tool: { name: string; risk?: string; approvalOnceOnly?: boolean }, args: Record<string, unknown>) => Promise<"once" | "always" | "deny">,
  ): Promise<{ ok: boolean; text: string; steps: number; messages: ChatMessage[]; stopReason?: string; metrics?: { requests?: Array<{ usage?: { input?: number; output?: number } }> } }>;
  close(): void;
}

export interface DriveOptions {
  home: string;
  workspace: string;
  model?: string;
  emit: (event: DriveEvent) => void;
  createRunner?: (config: LubanConfig) => DriveRunner;
  /** How long an approval waits for the window before it is treated as a deny. */
  approvalTimeoutMs?: number;
  /** Injectable clock, used by tests to assert deadlines. */
  now?: () => number;
  /**
   * Whether the human has the 电脑操控 switch on. Defaults to the shared control
   * session (which reads LUBAN_COMPUTER); tests replace it so the approval policy
   * can be exercised without a native helper or a real screen.
   */
  isComputerOn?: () => boolean;
}

/** Actions that only read the screen; they never need a second pair of eyes. */
const READ_ONLY_ACTIONS = new Set(["status", "windows", "screenshot", "cursor"]);

const ACTION_LABELS: Record<string, (args: Record<string, unknown>) => string> = {
  status: () => "检查屏幕与指针权限",
  windows: () => "查看屏幕上的窗口",
  app: args => `打开 ${String(args.name ?? "应用")}`,
  screenshot: args => (args.region ? "截取屏幕局部" : "截取整屏"),
  cursor: () => "读取光标位置",
  move: args => `移动指针到 ${point(args)}`,
  click: args => `${args.count === 2 ? "双击" : args.button === "right" ? "右键" : "点击"} ${point(args)}`,
  double_click: args => `双击 ${point(args)}`,
  right_click: args => `右键 ${point(args)}`,
  drag: args => `从 ${point(args.from)} 拖到 ${point(args.to)}`,
  scroll: args => `滚动 ${Number(args.dx ?? 0)}×${Number(args.dy ?? 0)}`,
  type: args => `输入「${short(String(args.text ?? ""), 40)}」`,
  key: args => `按键 ${[Array.isArray(args.modifiers) ? args.modifiers.join("+") : "", String(args.key ?? "")].filter(Boolean).join("+")}`,
};

function point(value: unknown): string {
  if (!value || typeof value !== "object") return "";
  const point = value as { x?: unknown; y?: unknown };
  const x = Number(point.x);
  const y = Number(point.y);
  return Number.isFinite(x) && Number.isFinite(y) ? `${Math.round(x)},${Math.round(y)}` : "";
}

function short(text: string, limit: number): string {
  const flat = text.replaceAll(/\s+/gu, " ").trim();
  return flat.length > limit ? `${flat.slice(0, limit - 1)}…` : flat;
}

/**
 * What the window shows for one action. The computer tool is the one that must
 * read like a sentence ("点击 720,430"), because it is the only tool whose
 * arguments a non-programmer has to be able to sanity-check at a glance.
 */
export function describeAction(name: string, args: Record<string, unknown>): string {
  if (name === "computer") {
    const action = String(args.action ?? "");
    return ACTION_LABELS[action]?.(args) ?? `电脑操控 ${action}`;
  }
  if (name === "bash") return `执行命令 ${short(String(args.command ?? args.script ?? ""), 60)}`;
  if (name === "write_file") return `写入 ${short(String(args.path ?? ""), 60)}`;
  if (name === "edit_file" || name === "apply_patch") return `修改 ${short(String(args.path ?? "文件"), 60)}`;
  if (name === "read_file" || name === "read_files") return `读取 ${short(String(args.path ?? "文件"), 60)}`;
  if (name === "attach_image") return `附加图片 ${short(String(args.path ?? ""), 60)}`;
  return name;
}

/** Pull the screenshot path out of the computer tool's JSON result.
 *
 * The control runner appends a sentence to that result ("这张截图已经附在本次
 * 请求里…"), so the preview is not pure JSON: read the object out of it rather
 * than demanding the whole string parse.
 */
export function screenshotPath(preview: string): string | undefined {
  const start = preview.indexOf("{");
  const end = preview.lastIndexOf("}");
  if (start < 0 || end <= start) return undefined;
  try {
    const parsed = JSON.parse(preview.slice(start, end + 1)) as { absolute?: unknown };
    return typeof parsed.absolute === "string" && parsed.absolute ? parsed.absolute : undefined;
  } catch { return undefined; }
}

interface PendingApproval {
  resolve: (allow: boolean) => void;
  timer?: ReturnType<typeof setTimeout>;
}

export class DriveSession {
  private readonly options: DriveOptions;
  private readonly approvalTimeoutMs: number;
  private config?: LubanConfig;
  private runner?: DriveRunner;
  private messages: ChatMessage[] = [];
  private readonly pending = new Map<string, PendingApproval>();
  private thinking = "";
  private thinkingTimer?: ReturnType<typeof setTimeout>;
  private controller?: AbortController;
  private turns = 0;
  private closing = false;
  private computer: DriveComputerState = { supported: computerSupported(), enabled: false };

  constructor(options: DriveOptions) {
    this.options = options;
    this.approvalTimeoutMs = options.approvalTimeoutMs ?? 120_000;
  }

  get state(): DriveComputerState {
    return this.computer;
  }

  get busy(): boolean {
    return this.controller !== undefined && !this.controller.signal.aborted;
  }

  /** Load the config, open the computer session (if the human opted in), announce. */
  async open(): Promise<void> {
    const config = loadConfig({ workspace: this.options.workspace, model: this.options.model, mesh: false, seedDefaults: true });
    this.config = config;
    this.messages = initialMessages(config.workspace, config.model.name, config.planning, "model", false, DRIVE_IDENTITY);
    this.messages.push({ role: "system", content: DRIVE_PROTOCOL });
    this.computer = await this.openComputer(config);
    this.emit({ type: "ready", workspace: config.workspace, model: config.model.id, computer: this.computer });
  }

  private async openComputer(config: LubanConfig): Promise<DriveComputerState> {
    if (!computerSupported()) {
      return { supported: false, enabled: false, note: "电脑操控只支持 macOS" };
    }
    // LUBAN_COMPUTER=1 is the window's switch: this process only drives the
    // desktop when the human turned it on, never because the model asked.
    const begun = await beginFromEnvironment(config.home, config.workspace).catch(error => {
      this.emit({ type: "error", text: `电脑操控启动失败：${error instanceof Error ? error.message : String(error)}` });
      return false;
    });
    if (!begun) {
      const permissions = await checkPermissions(config.home).catch(() => undefined);
      return {
        supported: true, enabled: false,
        accessibility: permissions?.accessible, postEvent: permissions?.postEvent, screenRecording: permissions?.screenRecording,
        note: "未打开「电脑操控」开关，只能读写文件，不能点击或输入",
      };
    }
    const permissions = await checkPermissions(config.home).catch(() => undefined);
    const ready = permissions?.accessible === true && permissions?.screenRecording === true;
    return {
      supported: true, enabled: true,
      accessibility: permissions?.accessible, postEvent: permissions?.postEvent, screenRecording: permissions?.screenRecording,
      note: ready ? "可以截屏、点击与输入" : "权限不完整：需要在系统设置 › 隐私与安全性 里打开「辅助功能」和「屏幕录制」",
    };
  }

  private emit(event: DriveEvent): void {
    this.options.emit(event);
  }

  /**
   * Reasoning arrives in one-to-three-word deltas; forwarding each one turns
   * the window into a stutter of a hundred bubbles. Hold them and hand over a
   * sentence-sized chunk, in order, before whatever came next.
   */
  private pushThinking(text: string): void {
    this.thinking += text;
    if (this.thinkingTimer) return;
    this.thinkingTimer = setTimeout(() => this.flushThinking(), THINKING_HOLD_MS);
    this.thinkingTimer.unref?.();
  }

  private flushThinking(): void {
    if (this.thinkingTimer) { clearTimeout(this.thinkingTimer); this.thinkingTimer = undefined; }
    const text = this.thinking.trim();
    this.thinking = "";
    if (text) this.emit({ type: "thinking", text });
  }

  /** One conversational turn. Rejects a second turn while one is running. */
  async say(text: string): Promise<void> {
    const prompt = text.trim();
    if (!prompt) return;
    if (!this.config) throw new Error("会话还没打开");
    if (this.busy) throw new Error("上一个任务还在执行，先停止或等它结束");
    const runner = this.ensureRunner();
    const id = `turn-${++this.turns}`;
    const controller = new AbortController();
    this.controller = controller;
    this.emit({ type: "turn-start", id, text: prompt });
    this.messages.push({ role: "user", content: prompt });
    try {
      const result = await runner.run(this.messages, "agent", controller.signal,
        event => this.onAgentEvent(event),
        (tool, args) => this.confirm(tool, args));
      this.messages = result.messages;
      this.flushThinking();
      this.emit({
        type: "turn-end", id, ok: result.ok, text: result.text, steps: result.steps,
        usage: this.usage(result.metrics?.requests), stopReason: result.stopReason,
      });
    } catch (error) {
      this.emit({ type: "error", text: error instanceof Error ? error.message : String(error) });
      this.emit({ type: "turn-end", id, ok: false, text: "", steps: 0, usage: { input: 0, output: 0, calls: 0 } });
    } finally {
      this.controller = undefined;
      this.settleAll("turn finished");
    }
  }

  private usage(requests?: Array<{ usage?: { input?: number; output?: number } }>): DriveUsage {
    const rows = requests ?? [];
    return {
      input: rows.reduce((sum, row) => sum + (row.usage?.input ?? 0), 0),
      output: rows.reduce((sum, row) => sum + (row.usage?.output ?? 0), 0),
      calls: rows.length,
    };
  }

  private ensureRunner(): DriveRunner {
    if (this.runner) return this.runner;
    const config = this.config;
    if (!config) throw new Error("会话还没打开");
    if (this.options.createRunner) {
      this.runner = this.options.createRunner(config);
      return this.runner;
    }
    // The window is the consent surface, so this session never inherits a
    // global "allow everything": clicks ask here even when the CLI is in AUTO.
    const sessionConfig = { ...config, permissionMode: "edits" as const, permissions: { allow: [], deny: config.permissions?.deny ?? [] } };
    this.runner = new AgentRunner(sessionConfig, undefined, undefined, 0, { toolset: "computer" }) as unknown as DriveRunner;
    return this.runner;
  }

  private onAgentEvent(event: AgentEvent): void {
    if (event.type === "delta") { this.flushThinking(); this.emit({ type: "text", text: event.text }); return; }
    if (event.type === "thinking-delta") { this.pushThinking(event.text); return; }
    if (event.type === "status" && !event.progress) { this.emit({ type: "status", text: event.text }); return; }
    if (event.type === "tool-start") {
      this.flushThinking();
      this.emit({ type: "tool", id: event.id, name: event.name, label: describeAction(event.name, event.args), args: event.args });
      return;
    }
    if (event.type === "tool-end") {
      this.flushThinking();
      this.emit({
        type: "tool-result", id: event.id, name: event.name, ok: event.ok, elapsedMs: event.elapsedMs,
        preview: event.preview, screenshot: screenshotPath(event.preview),
      });
      return;
    }
    if (event.type === "error") this.emit({ type: "error", text: event.text });
  }

  /**
   * The approval policy. Read-only work is free; everything that changes the
   * screen, the disk or the network waits for the window, and a timeout denies.
   */
  private async confirm(tool: { name: string; risk?: string; approvalOnceOnly?: boolean }, args: Record<string, unknown>): Promise<"once" | "always" | "deny"> {
    const config = this.config;
    if (tool.name === "computer") {
      const action = String(args.action ?? "");
      if (READ_ONLY_ACTIONS.has(action)) return "once";
      const on = this.options.isComputerOn
        ? this.options.isComputerOn()
        : computerControl({ home: config?.home, workspace: config?.workspace }).enabled;
      if (!on) {
        this.emit({ type: "error", text: "电脑操控未打开，动作已拒绝" });
        return "deny";
      }
    } else if (tool.risk === "read" && !tool.approvalOnceOnly) {
      // Reading is what makes the timeline worth watching; asking about it turns
      // the window into a dead end where every turn stalls on "read_file".
      return "once";
    }
    const id = randomUUID();
    const label = describeAction(tool.name, args);
    const reason = tool.name === "computer"
      ? "这一步会改变屏幕上的内容"
      : tool.risk === "network" ? "这一步会访问网络" : "这一步会改动磁盘或执行命令";
    const allow = await this.ask(id, tool.name, label, args, reason);
    if (!allow) return "deny";
    // One yes is for this session, not per click: a person who allowed the
    // computer to be driven does not want seven prompts to type a number.
    this.emit({ type: "status", text: "已允许本次会话的屏幕操作；随时可以点停止" });
    return "always";
  }

  private ask(id: string, tool: string, label: string, args: Record<string, unknown>, reason: string): Promise<boolean> {
    this.emit({ type: "approval", id, tool, label, args, reason });
    return new Promise<boolean>(resolve => {
      const timer = setTimeout(() => this.settle(id, false, "超时自动拒绝"), this.approvalTimeoutMs);
      timer.unref?.();
      this.pending.set(id, { resolve, timer });
    });
  }

  private settle(id: string, allow: boolean, reason: string): void {
    const pending = this.pending.get(id);
    if (!pending) return;
    this.pending.delete(id);
    if (pending.timer) clearTimeout(pending.timer);
    this.emit({ type: "approval-settled", id, allow, reason });
    pending.resolve(allow);
  }

  private settleAll(reason: string): void {
    for (const id of [...this.pending.keys()]) this.settle(id, false, reason);
  }

  /** Answer an approval the window showed. Unknown or late ids are ignored. */
  approve(id: string, allow: boolean): boolean {
    if (!this.pending.has(id)) return false;
    this.settle(id, allow, allow ? "已在窗口允许" : "已在窗口拒绝");
    return true;
  }

  /** ⌘. / 停止: abort the running turn; pending approvals become denials. */
  stop(): void {
    this.settleAll("已停止");
    this.controller?.abort(new Error("stopped"));
    computerControl().end();
  }

  close(): void {
    if (this.closing) return;
    this.closing = true;
    this.settleAll("会话结束");
    this.controller?.abort(new Error("closed"));
    this.runner?.close();
    computerControl().end();
  }
}

/** The session names itself in its own body, like the bot worker does. */
const DRIVE_IDENTITY = "造物主 (the creator of this workspace)";

/** How long reasoning deltas are collected before one thinking event is sent. */
const THINKING_HOLD_MS = 260;

/**
 * The control session's whole job is eyes and hands, so say so in the prompt
 * too: the toolset already removed bash, but a model told to "operate the
 * computer" will still write a script in its head unless the loop is spelled
 * out — look, act, look again.
 */
export const DRIVE_PROTOCOL = [
  "这个会话用来「操控这台电脑」：你只有眼睛和手，没有终端，也没有编辑器。",
  "每一步按这个循环做：",
  "1. computer {action:\"windows\"} —— 看前台应用、屏幕上每个窗口的 x/y/宽/高，以及屏幕尺寸。",
  "2. computer {action:\"screenshot\"} —— 看画面。截出来的图会自动附在本次请求里，你下一次就能直接看到，不用再调 attach_image。",
  "3. 动手：app 打开应用、click 点按钮、type 往输入框写字、key 提交、scroll 滚动。",
  "坐标已经算好、而且这些动作不会互相改变布局时（比如连点计算器的数字键），可以在同一条回复里连续发多个 computer，不必一次一个来回。拿不准就先做一个再看。",
  "键盘不总是可靠：计算器这类用按钮的数字键盘，点按钮比 type 更准；type 适合文本框。",
  "4. 做完再截一次图确认结果，然后才回答用户。",
  "截图一定送到了：tool 结果后面写着「已经附在本次请求里」，你就已经看过这张图。不要因为「我感觉没看到图」重复截图——那只会拖慢自己；真的看不清就给 screenshot 加 region:{x,y,width,height} 放大一小块。",
  "坐标规则：所有坐标都是屏幕「点」，不是截图里的像素。截图返回的 screen 是点尺寸，pixels 通常是它的 2 倍；windows 给的窗口位置和大小已经是点。",
  "别猜坐标：先 windows 拿到窗口范围，再在范围内点；点偏了就看截图重新算。",
].join("\n");
