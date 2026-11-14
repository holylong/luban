/* The approval policy is the whole safety story of 造物主's control mode.
 *
 * A scripted runner stands in for the model, so these assertions are about the
 * session's rules and not about any provider: which actions run unattended,
 * which ones wait for the window, and what happens when nobody answers.
 */
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { DRIVE_PROTOCOL, DriveSession, describeAction, screenshotPath, type DriveEvent } from "./drive";
import { readProjectMemory, rememberFact } from "./memory";
import { updateCreatorIdentity } from "./creator-identity";
import type { AgentEvent, ChatMessage } from "./types";

const homes: string[] = [];
function tempHome(): string {
  const home = mkdtempSync(join(tmpdir(), "luban-drive-"));
  homes.push(home);
  return home;
}
afterEach(() => {
  while (homes.length) rmSync(homes.pop()!, { recursive: true, force: true });
});

type Script = (approve: Approve, onEvent: (event: AgentEvent) => void) => Promise<{ ok?: boolean; text?: string }>;
type Approve = (tool: { name: string; risk?: string; approvalOnceOnly?: boolean }, args: Record<string, unknown>) => Promise<"once" | "always" | "deny">;

/** A runner that replays a fixed script instead of calling a model. */
function scripted(script: Script) {
  return () => ({
    async run(_messages: ChatMessage[], _mode: string, _signal: AbortSignal, onEvent: (event: AgentEvent) => void, approve: Approve) {
      const result = await script(approve, onEvent);
      return {
        ok: result.ok ?? true, text: result.text ?? "done", steps: 1, messages: [] as ChatMessage[],
        metrics: { requests: [{ usage: { input: 10, output: 2 } }] },
      };
    },
    close() {},
  });
}

function session(runner: () => ReturnType<ReturnType<typeof scripted>>, events: DriveEvent[], extra: { timeout?: number; preapproved?: string[]; computerOn?: boolean } = {}) {
  const home = tempHome();
  const drive = new DriveSession({
    home, workspace: home, emit: event => events.push(event),
    createRunner: runner as never,
    approvalTimeoutMs: extra.timeout ?? 5_000,
    // Pretend the window's 电脑操控 switch is on; the policy is what is under test.
    isComputerOn: () => extra.computerOn !== false,
    isPreapproved: name => (extra.preapproved ?? []).includes(name),
  });
  return { drive, home };
}

describe("describeAction", () => {
  it("turns computer arguments into a sentence a person can check", () => {
    expect(describeAction("computer", { action: "click", x: 720, y: 430 })).toBe("点击 720,430");
    expect(describeAction("computer", { action: "drag", from: { x: 1, y: 2 }, to: { x: 300, y: 400 } })).toBe("从 1,2 拖到 300,400");
    expect(describeAction("computer", { action: "type", text: "hello world" })).toBe("输入「hello world」");
    expect(describeAction("computer", { action: "key", key: "t", modifiers: ["cmd"] })).toBe("按键 cmd+t");
    expect(describeAction("computer", { action: "screenshot" })).toBe("截取整屏");
    expect(describeAction("computer", { action: "windows" })).toBe("查看屏幕上的窗口");
    expect(describeAction("computer", { action: "app", name: "计算器" })).toBe("打开 计算器");
    // A reminder is an action in the timeline too, not the bare tool name.
    expect(describeAction("schedule", { text: "提醒我下班", in: "5m", notify: true })).toBe("定时提醒 +5m · 提醒我下班");
    expect(describeAction("schedule", { text: "汇总今天提交", every: "1h" })).toBe("定时任务 现在 · 汇总今天提交");
  });

  it("tells the model to look before it touches anything", () => {
    // The live run that motivated this prompt used bash and osascript nine times
    // and never clicked; the protocol has to name the loop and the coordinate unit.
    expect(DRIVE_PROTOCOL).toContain("windows");
    expect(DRIVE_PROTOCOL).toContain("点");
    expect(DRIVE_PROTOCOL).toContain("不是截图里的像素");
    // A window you can talk to must not turn every request into screenshot
    // analysis: documents use file tools, and a plain question uses nothing.
    expect(DRIVE_PROTOCOL).toContain("read_file");
    expect(DRIVE_PROTOCOL).toContain("直接回答，一个工具都不要调");
    expect(DRIVE_PROTOCOL).toContain("不要截屏");
    expect(DRIVE_PROTOCOL).toContain("不要改成 osascript");
    // One live run wasted 4 screenshots re-taking the picture it had already seen.
    expect(DRIVE_PROTOCOL).toContain("重复截同一块");
  });

  it("sends reminders to luban's own scheduler instead of the system calendar", () => {
    // The old bullet wrote an osascript event into 日历/提醒事项: macOS-only,
    // invisible to `luban bot list`, and gone the moment the user moves to
    // Windows or Ubuntu. A reminder is a queue task with kind=notify.
    expect(DRIVE_PROTOCOL).toContain("schedule");
    expect(DRIVE_PROTOCOL).toContain("notify:true");
    expect(DRIVE_PROTOCOL).toContain("crontab");
    expect(DRIVE_PROTOCOL).not.toContain("往「日历」或「提醒事项」里写一条");
    expect(DRIVE_PROTOCOL).toContain("luban bot list");
  });

  it("finds the screenshot path even when the result grew a sentence", () => {
    // The control runner appends 「已经附在本次请求里」 to every screenshot result;
    // plain JSON.parse then failed and the window drew an action with no picture.
    const result = `{\n  "path": ".luban/computer/shot-1.png",\n  "absolute": "/tmp/ws/.luban/computer/shot-1.png",\n  "bytes": 12\n}\n\n这张截图已经附在本次请求里：下一步的模型调用就能看到画面。`;
    expect(screenshotPath(result)).toBe("/tmp/ws/.luban/computer/shot-1.png");
    expect(screenshotPath("点击 (12, 34)")).toBeUndefined();
  });

  it("names non-computer tools by what they touch", () => {
    expect(describeAction("bash", { command: "ls -la" })).toBe("执行命令 ls -la");
    expect(describeAction("write_file", { path: "notes.md" })).toBe("写入 notes.md");
  });
});

describe("approval policy", () => {
  it("lets a read-only action through without asking", async () => {
    const events: DriveEvent[] = [];
    let verdict = "";
    const { drive } = session(scripted(async approve => {
      verdict = await approve({ name: "computer", risk: "execute" }, { action: "screenshot" });
      return {};
    }), events);
    await drive.open();
    await drive.say("截图看看");
    expect(verdict).toBe("once");
    expect(events.some(event => event.type === "approval")).toBe(false);
  });

  it("waits for the window before anything that changes the screen", async () => {
    const events: DriveEvent[] = [];
    let verdict = "";
    const { drive } = session(scripted(async (approve, onEvent) => {
      onEvent({ type: "tool-start", id: "t1", name: "computer", args: { action: "click", x: 720, y: 430 } });
      const pending = approve({ name: "computer", risk: "execute" }, { action: "click", x: 720, y: 430 });
      // The window answers on its own clock, from the event it was just shown.
      const asked = events.find(event => event.type === "approval");
      expect(asked && asked.type === "approval" ? asked.label : "").toBe("点击 720,430");
      drive.approve(asked!.id as string, true);
      verdict = await pending;
      return {};
    }), events);
    await drive.open();
    await drive.say("点一下那个按钮");
    // One yes covers the session: per-click prompts would make typing 12*34 a quiz.
    expect(verdict).toBe("always");
    expect(events.map(event => event.type)).toContain("approval-settled");
    const settled = events.find(event => event.type === "approval-settled");
    expect(settled?.type === "approval-settled" ? settled.allow : undefined).toBe(true);
  });

  it("denies when the window says no", async () => {
    const events: DriveEvent[] = [];
    let verdict = "";
    const { drive } = session(scripted(async (approve) => {
      const pending = approve({ name: "computer", risk: "execute" }, { action: "type", text: "rm -rf" });
      const asked = events.find(event => event.type === "approval");
      drive.approve(asked!.id as string, false);
      verdict = await pending;
      return {};
    }), events);
    await drive.open();
    await drive.say("打字");
    expect(verdict).toBe("deny");
  });

  it("treats silence as a denial instead of hanging the turn", async () => {
    const events: DriveEvent[] = [];
    let verdict = "";
    const { drive } = session(scripted(async (approve) => {
      verdict = await approve({ name: "computer", risk: "execute" }, { action: "click", x: 1, y: 1 });
      return {};
    }), events, { timeout: 30 });
    await drive.open();
    await drive.say("点一下");
    expect(verdict).toBe("deny");
    const settled = events.find(event => event.type === "approval-settled");
    expect(settled?.type === "approval-settled" ? settled.reason : "").toContain("超时");
  });

  it("frees a pending approval when the turn is stopped", async () => {
    const events: DriveEvent[] = [];
    let verdict = "";
    const { drive } = session(scripted(async (approve, onEvent) => {
      onEvent({ type: "status", text: "waiting" });
      setTimeout(() => drive.stop(), 5);
      verdict = await approve({ name: "computer", risk: "execute" }, { action: "click", x: 2, y: 3 });
      return { ok: false };
    }), events, { timeout: 10_000 });
    await drive.open();
    await drive.say("点一下");
    expect(verdict).toBe("deny");
    expect(events.some(event => event.type === "turn-end")).toBe(true);
  });

  it("asks before writing files and answers reads itself", async () => {
    const events: DriveEvent[] = [];
    const answers: string[] = [];
    const { drive } = session(scripted(async approve => {
      answers.push(await approve({ name: "read_file", risk: "read" }, { path: "a.ts" }));
      const writing = approve({ name: "write_file", risk: "write" }, { path: "a.ts" });
      drive.approve(events.find(event => event.type === "approval")!.id as string, false);
      answers.push(await writing);
      return {};
    }), events);
    await drive.open();
    await drive.say("改一下文件");
    expect(answers).toEqual(["once", "deny"]);
  });

  it("remembers a 允许 across sessions instead of asking every launch", async () => {
    const events: DriveEvent[] = [];
    let verdict = "";
    const { drive } = session(scripted(async approve => {
      verdict = await approve({ name: "computer", risk: "execute" }, { action: "click", x: 5, y: 6 });
      return {};
    }), events, { preapproved: ["computer"] });
    await drive.open();
    await drive.say("点一下");
    expect(verdict).toBe("always");
    expect(events.some(event => event.type === "approval")).toBe(false);
    // One line explains why nothing asked; repeating it every click would be noise.
    const notices = events.filter(event => event.type === "status" && event.text.includes("沿用上次的授权"));
    expect(notices).toHaveLength(1);
  });

  it("never lets a remembered 允许 outlive the 操控 switch", async () => {
    const events: DriveEvent[] = [];
    let verdict = "";
    const { drive } = session(scripted(async approve => {
      verdict = await approve({ name: "computer", risk: "execute" }, { action: "click", x: 5, y: 6 });
      return {};
    }), events, { preapproved: ["computer"], computerOn: false });
    await drive.open();
    await drive.say("点一下");
    expect(verdict).toBe("deny");
    expect(events.some(event => event.type === "error" && event.text.includes("电脑操控未打开"))).toBe(true);
  });

  it("still asks for a restart command even when the tool is remembered", async () => {
    const events: DriveEvent[] = [];
    const answers: string[] = [];
    const { drive } = session(scripted(async approve => {
      const pending = approve({ name: "bash", risk: "execute", approvalOnceOnly: true }, { command: "npm run dev" });
      drive.approve(events.find(event => event.type === "approval")!.id as string, true);
      answers.push(await pending);
      answers.push(await approve({ name: "bash", risk: "execute" }, { command: "npm test" }));
      return {};
    }), events, { preapproved: ["bash"] });
    await drive.open();
    await drive.say("重启一下");
    expect(answers).toEqual(["once", "always"]);
    expect(events.filter(event => event.type === "approval")).toHaveLength(1);
  });
});

describe("events", () => {
  it("announces each action with its label and keeps the screenshot path", async () => {
    const events: DriveEvent[] = [];
    const { drive } = session(scripted(async (_approve, onEvent) => {
      onEvent({ type: "tool-start", id: "s1", name: "computer", args: { action: "click", x: 12, y: 34 } });
      onEvent({ type: "tool-end", id: "s1", name: "computer", ok: true, elapsedMs: 12, preview: "clicked" });
      onEvent({ type: "tool-start", id: "s2", name: "computer", args: { action: "screenshot" } });
      onEvent({ type: "tool-end", id: "s2", name: "computer", ok: true, elapsedMs: 40, preview: JSON.stringify({ path: "shots/a.png", absolute: "/tmp/shots/a.png", bytes: 10 }) });
      return {};
    }), events);
    await drive.open();
    await drive.say("点一下再截图");
    const tool = events.find(event => event.type === "tool");
    expect(tool?.type === "tool" ? tool.label : "").toBe("点击 12,34");
    const shot = events.find(event => event.type === "tool-result" && event.screenshot);
    expect(shot?.type === "tool-result" ? shot.screenshot : "").toBe("/tmp/shots/a.png");
  });

  it("reports readiness with the model and what the desktop allows", async () => {
    const events: DriveEvent[] = [];
    const { drive } = session(scripted(async () => ({})), events);
    await drive.open();
    const ready = events[0];
    expect(ready.type).toBe("ready");
    const state = ready.type === "ready" ? ready.computer : undefined;
    // The session itself must never claim desktop control it was not given.
    expect(state?.enabled).toBe(false);
  });

  it("refuses a second turn while one is running", async () => {
    const events: DriveEvent[] = [];
    let release: (() => void) | undefined;
    const { drive } = session(scripted(async () => {
      await new Promise<void>(resolve => { release = resolve; });
      return {};
    }), events);
    await drive.open();
    const first = drive.say("第一句");
    await new Promise(resolve => setTimeout(resolve, 20));
    await expect(drive.say("第二句")).rejects.toThrow(/还在执行/u);
    release?.();
    await first;
  });
});

describe("no mechanical shortcuts", () => {
  it("gives a reminder sentence to the model instead of answering it itself", async () => {
    // "5 分钟后提醒我下班" used to be parsed by a local regex and turned into a
    // queue entry before the model ever saw it. That is a second, dumber agent:
    // it has to know every phrasing, it cannot ask a question back, and the
    // sentence never reaches the model that was supposed to act on it.
    const events: DriveEvent[] = [];
    let turns = 0;
    const { drive, home } = session(scripted(async () => {
      turns += 1;
      return { text: "已排：5 分钟后提醒你下班" };
    }), events);
    await drive.open();
    await drive.say("5 分钟后提醒我下班");
    expect(turns).toBe(1);
    // Nothing was booked behind the model's back, and the timeline shows a real
    // turn (usage included) rather than a fabricated `schedule` action.
    expect(existsSync(join(home, "bot", "tasks"))).toBe(false);
    expect(events.some(event => event.type === "tool")).toBe(false);
    const end = events.find(event => event.type === "turn-end");
    expect(end?.type === "turn-end" ? end.usage.calls : 0).toBe(1);
  });
});

describe("global identity in Creator", () => {
  it("refreshes the identity each turn and carries it to a restarted session on another workspace", async () => {
    const seen: string[] = [];
    const runner = () => ({
      async run(messages: ChatMessage[]) {
        seen.push(String(messages[0]?.content));
        return { ok: true, text: "好", steps: 1, messages, metrics: { requests: [] } };
      }, close() {},
    });
    const { drive, home } = session(runner as never, []);
    await drive.open();
    await drive.say("你好");
    await updateCreatorIdentity(home, { name: "小鲁", personality: "温柔", userName: "小林" });
    await drive.say("你叫什么");
    expect(seen[1]).toContain('"name":"小鲁"');
    expect(seen[1]).not.toContain("你是造物主");
    const restarted = new DriveSession({ home, workspace: tempHome(), emit: () => {}, createRunner: runner as never });
    await restarted.open();
    await restarted.say("你是谁");
    expect(seen[2]).toContain('"userName":"小林"');
    drive.close(); restarted.close();
  });

  it("requires fresh approval even if the identity tool was preapproved", async () => {
    const events: DriveEvent[] = [];
    let decision: string | undefined;
    const { drive } = session(scripted(async approve => {
      decision = await approve({ name: "update_creator_identity", risk: "write", approvalOnceOnly: true }, { name: "小鲁" });
      return {};
    }), events, { preapproved: ["update_creator_identity"] });
    await drive.open();
    const turn = drive.say("以后叫你小鲁");
    for (let i = 0; i < 100 && !events.some(e => e.type === "approval"); i++) await new Promise(r => setTimeout(r, 10));
    const approval = events.find(e => e.type === "approval");
    expect(approval?.type).toBe("approval");
    if (approval?.type === "approval") drive.approve(approval.id, true);
    await turn;
    expect(decision).toBe("once");
    drive.close();
  });
});

describe("cross-run memory", () => {
  /** A runner that records the prompt the session actually sent. */
  function capturing(seen: ChatMessage[][], text = "扫了本周新增 bug，找到 3 个。") {
    return () => ({
      async run(messages: ChatMessage[], _mode: string, _signal: AbortSignal, _onEvent: (event: AgentEvent) => void, _approve: Approve) {
        seen.push(messages);
        return { ok: true, text, steps: 1, messages, metrics: { requests: [{ usage: { input: 10, output: 2 } }] } };
      },
      close() {},
    });
  }

  it("gives the model what this project already knows", async () => {
    const events: DriveEvent[] = [];
    const seen: ChatMessage[][] = [];
    const { drive, home } = session(capturing(seen), events);
    await rememberFact(home, home, "禅道 bug 项目的 id 是 42");
    await drive.open();
    await drive.say("再扫一下本周 bug");

    const sent = seen[0]!;
    const memory = sent.findIndex(message => message.role === "system" && String(message.content).includes("禅道 bug 项目的 id 是 42"));
    expect(memory).toBeGreaterThan(-1);
    // Immediately before the question, so it reads as context for this turn.
    expect(sent[memory + 1]?.role).toBe("user");
    expect(String(sent[memory + 1]?.content)).toBe("再扫一下本周 bug");
  });

  it("writes one journal line and keeps it out of the transcript", async () => {
    const events: DriveEvent[] = [];
    const seen: ChatMessage[][] = [];
    const { drive, home } = session(capturing(seen), events);
    await drive.open();
    await drive.say("扫一下本周 bug");
    const journal = await readProjectMemory(home, home);
    expect(journal.runs.map(run => run.text)).toEqual(["扫了本周新增 bug，找到 3 个。"]);

    // Second turn: one block, not two, and the first one is gone from history.
    await drive.say("这次呢");
    const blocks = seen[1]!.filter(message => message.role === "system" && String(message.content).startsWith("## 项目记忆（"));
    expect(blocks).toHaveLength(1);
    expect(String(blocks[0]!.content)).toContain("扫了本周新增 bug");
  });

  it("costs nothing on a project that has no memory yet", async () => {
    const events: DriveEvent[] = [];
    const seen: ChatMessage[][] = [];
    const { drive } = session(capturing(seen), events);
    await drive.open();
    await drive.say("第一句话");
    expect(seen[0]!.some(message => message.role === "system" && String(message.content).startsWith("## 项目记忆（"))).toBe(false);
  });
});
