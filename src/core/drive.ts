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
  private runnerMode: "all" | "computer" = "all";
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
    const runner = this.ensureRunner(screenIntent(prompt) ? "computer" : "all");
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

  private ensureRunner(mode: "all" | "computer" = "all"): DriveRunner {
    if (this.runner && this.runnerMode === mode) return this.runner;
    // Screen work and desk work want different hands, and the runner owns its
    // tool map: "open the calculator" gets eyes and hands only (a shell there
    // turns into osascript guessing), everything else keeps the full toolbox.
    if (this.runner) {
      try { this.runner.close(); } catch { /* a closed runner is the goal */ }
      this.runner = undefined;
    }
    this.runnerMode = mode;
    const config = this.config;
    if (!config) throw new Error("会话还没打开");
    if (this.options.createRunner) {
      this.runner = this.options.createRunner(config);
      return this.runner;
    }
    // The window is the consent surface, so this session never inherits a
    // global "allow everything": clicks ask here even when the CLI is in AUTO.
    const sessionConfig = { ...config, permissionMode: "edits" as const, permissions: { allow: [], deny: config.permissions?.deny ?? [] } };
    this.runner = new AgentRunner(sessionConfig, undefined, undefined, 0, { toolset: mode }) as unknown as DriveRunner;
    return this.runner;
  }

  /** MCP wiring是终端里的信息，不是「替我做这件事」的画面：窗口里不显示。 */
  private static readonly QUIET_STATUS = /^(Connected \d+ MCP tools|MCP 工具已注册)/;

  private onAgentEvent(event: AgentEvent): void {
    if (event.type === "status" && DriveSession.QUIET_STATUS.test(event.text)) return;
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
 * A window you can talk to is not a screenshot pipeline. The model keeps the
 * ordinary tools — files, documents, commands — and only reaches for the screen
 * when the task is actually about what is on it. Earlier this session was pinned
 * to the computer tool alone, and then "帮我整理这份文档" came back as a
 * screenshot analysis, which is both slower and useless.
 */
/**
 * Does this sentence ask about what is on the screen? Only then is the turn
 * narrowed to eyes and hands — "整理这份文档" wants files, "设个明早 8 点的
 * 闹钟" wants a shell command, and neither should cost a screenshot.
 */
const SCREEN_TERMS = /(截屏|截图|屏幕|窗口|界面|光标|鼠标|点击|点一下|点开|双击|右键|拖动|滚动|按钮|菜单|弹窗|表单|输入框|计算器|日历|备忘录|提醒事项|访达|finder|safari|chrome|浏览器|微信|飞书|钉钉|系统设置|网易云|播放器|vscode|excel|word|numbers|pages|keynote|preview)/i;

export function screenIntent(text: string): boolean {
  return SCREEN_TERMS.test(text);
}

export const DRIVE_PROTOCOL = [
  "你是造物主，坐在这台 Mac 前面替用户办事。先规划再动手：想清楚这件事该用什么手段，只调真正需要的那一个。",
  "- 只是问一句、要个解释或意见：直接回答，一个工具都不要调。",
  "- 文档、代码、文件、命令、查资料：用普通工具（read_file / write_file / bash 等），和终端里一样干活，不要截屏。",
  "- 定时、提醒、闹钟：用命令把事排进系统，不要盯着屏幕看。例如「明天早上 8 点叫我」→ bash 执行 osascript 往「日历」或「提醒事项」里写一条带提醒的事件（到点系统自己弹），或者 luban bot add --at <ISO 时间> \"提醒我…\" 排一条后台任务；回答里写清你排了什么、几点响。",
  "- 只有「屏幕上的东西」才用 computer：要打开某个应用去看、点按钮、在只有界面的地方操作。这时你只有眼睛和手。",
  "真要操作界面时：",
  "1. computer {action:\"windows\"} 拿前台应用和每个窗口的 x/y/宽/高（单位是屏幕「点」）。",
  "2. computer {action:\"screenshot\"} 看画面。图会自动附在本次请求里，下一次就能看到，不用再 attach_image。",
  "3. 动手：app 打开应用、click 点、type 写字、key 提交、scroll 滚动。坐标已经算好、动作之间又不改变布局时，可以在一条回复里连发多个动作。",
  "4. 做完再截一次图确认结果，然后回答。",
  "坐标规则：都用屏幕「点」，不是截图里的像素。截图结果里的 origin 是这张图左上角在屏幕上的位置，屏幕坐标 = origin + 图内偏移。",
  "屏幕上要点的东西用 computer 点，不要改成 osascript / 截图量像素去猜。",
  "截图一定送到了：不要因为「感觉没看到图」重复截同一块；看不清就用 screenshot 加 region 放大。",
].join("\n");
