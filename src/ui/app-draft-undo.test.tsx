import React from "react";
import { PassThrough } from "node:stream";
import { mkdtemp, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { render } from "ink";
import { expect, it, vi } from "vitest";
import { AgentRunner } from "../core/agent.js";
import { loadConfig } from "../core/config.js";
import { SessionStore } from "../core/session-store.js";
import { App } from "./app.js";
import { readFrame } from "./test-frames.js";

/** Shared harness: a rendered TUI whose composer can be read back per frame. */
async function harness(options: { pendingInputs?: Array<{ id: string; content: string; delivery: "queue" | "steer" }> } = {}) {
  const home = await mkdtemp(join(tmpdir(), "luban-undo-ui-"));
  const workspace = join(home, "workspace");
  await mkdir(workspace);
  const oldHome = process.env.LUBAN_HOME;
  process.env.LUBAN_HOME = home;
  const config = loadConfig({ workspace });
  const store = new SessionStore(home);
  const session = store.create(config.project, workspace, "auto", config.model.id, [
    { role: "user", content: "original request" },
    { role: "assistant", content: "previous answer" },
  ]);
  if (options.pendingInputs) session.pendingInputs = options.pendingInputs.map((item) => ({ ...item, createdAt: new Date(0).toISOString() }));
  // The file has to exist before `resume` can reopen it.
  await store.save(session);
  const stdin = Object.assign(new PassThrough(), { isTTY: true, setRawMode() {}, ref() {}, unref() {} });
  const stdout = Object.assign(new PassThrough(), { columns: 100, rows: 30, isTTY: true });
  let frame = "";
  // readFrame keeps the newest repaint whatever the chunk boundaries were: the
  // header changes (mode label, computer pill) and never appears alone.
  stdout.on("data", (data) => { frame = readFrame(stdout, data); });
  const app = render(<App config={config} resume={session.id} />, {
    stdin: stdin as unknown as NodeJS.ReadStream, stdout: stdout as unknown as NodeJS.WriteStream,
    debug: false, patchConsole: false, exitOnCtrlC: false,
    // Ink otherwise rewrites only the lines that changed, and the assertions
    // below read the composer and hint rows out of one full frame.
    incrementalRendering: false,
  });
  const composer = () => frame.slice(frame.lastIndexOf("❯"));
  return {
    stdin, store, config, session, app, composer,
    frame: () => frame,
    type: (text: string) => stdin.write(text),
    press: (key: string) => stdin.write(key),
    cleanup: () => {
      app.unmount();
      app.cleanup();
      if (oldHome === undefined) delete process.env.LUBAN_HOME;
      else process.env.LUBAN_HOME = oldHome;
    },
  };
}

it("puts a long one-line draft away with the down arrow and recalls it with up", async () => {
  const ui = await harness();
  const draft = "refactor the billing module and keep the public API unchanged";
  try {
    await expect.poll(() => ui.frame(), { timeout: 5000 }).toContain("previous answer");
    ui.type(draft);
    await expect.poll(ui.composer).toContain(draft);
    // A one-line draft has no caret move left for Down, so it clears the box
    // instead of doing nothing.
    ui.press("\u001b[B");
    await expect.poll(ui.composer).toContain("Message luban");
    await expect.poll(() => ui.frame()).toContain("已收起输入");
    // The text is not lost: it went into the saved input history.
    await expect.poll(async () => (await ui.store.load(ui.session.id, ui.config.project))?.inputHistory?.at(-1)).toBe(draft);
    ui.press("\u001b[A");
    await expect.poll(ui.composer).toContain(draft);
  } finally {
    ui.cleanup();
  }
}, 15000);

it("only pushes a multi-line draft out on down at the last line", async () => {
  const ui = await harness();
  try {
    await expect.poll(() => ui.frame(), { timeout: 5000 }).toContain("previous answer");
    ui.type("first line\nsecond line");
    await expect.poll(ui.composer).toContain("second line");
    // Up and back down is plain caret movement: the draft must survive it.
    ui.press("\u001b[A");
    await new Promise((resolve) => setTimeout(resolve, 80));
    await expect.poll(ui.composer).toContain("first line");
    ui.press("\u001b[B");
    await new Promise((resolve) => setTimeout(resolve, 80));
    await expect.poll(ui.composer).toContain("second line");
    // Down on the last line has nowhere left to go, so it clears the box.
    ui.press("\u001b[B");
    await expect.poll(ui.composer).toContain("Message luban");
    await expect.poll(() => ui.frame()).toContain("已收起输入");
    ui.press("\u001b[A");
    await expect.poll(ui.composer).toContain("second line");
  } finally {
    ui.cleanup();
  }
}, 15000);

it("leaves the draft alone when the down arrow belongs to the command menu", async () => {
  const ui = await harness();
  try {
    await expect.poll(() => ui.frame(), { timeout: 5000 }).toContain("previous answer");
    ui.type("/mo");
    await expect.poll(() => ui.frame()).toContain("命令 · ↑↓ 选择");
    ui.press("\u001b[B");
    await new Promise((resolve) => setTimeout(resolve, 120));
    // Down moved the menu selection; the typed command must stay in the box.
    await expect.poll(ui.composer).toContain("/mo");
    expect(ui.frame()).not.toContain("已收起输入");
  } finally {
    ui.cleanup();
  }
}, 15000);

it("clears an idle draft with Esc and restores it on the next Esc", async () => {
  const ui = await harness();
  try {
    await expect.poll(() => ui.frame(), { timeout: 5000 }).toContain("previous answer");
    ui.type("half typed insturction");
    await expect.poll(ui.composer).toContain("half typed insturction");
    ui.press("\u001b");
    await expect.poll(ui.composer).toContain("Message luban");
    await expect.poll(() => ui.frame()).toContain("已清空输入");
    ui.press("\u001b");
    await expect.poll(ui.composer).toContain("half typed insturction");
    await expect.poll(() => ui.frame()).toContain("已恢复输入");
    // The restored text is a normal draft: it can be edited and submitted.
    ui.type(" edited");
    await expect.poll(ui.composer).toContain("half typed insturction edited");
  } finally {
    ui.cleanup();
  }
}, 15000);

it("puts an interrupted instruction back in the composer for editing", async () => {
  const ui = await harness();
  const run = vi.spyOn(AgentRunner.prototype, "run").mockImplementation(async (_messages, _mode, signal) =>
    new Promise((_resolve, reject) => {
      const abort = () => reject(signal.reason);
      if (signal.aborted) abort();
      else signal.addEventListener("abort", abort, { once: true });
    }) as never);
  try {
    await expect.poll(() => ui.frame(), { timeout: 5000 }).toContain("previous answer");
    ui.type("deploy the prod database by mistake");
    await expect.poll(ui.composer).toContain("deploy the prod");
    ui.press("\r");
    // The composer placeholder is the running indicator in this layout.
    await expect.poll(() => ui.frame(), { timeout: 8000 }).toContain("补充指令 · /queue 排队 · Esc 中断");
    ui.press("\u001b");
    await expect.poll(() => ui.frame(), { timeout: 8000 }).toContain("指令已放回输入框");
    // The exact line that was sent comes back, so the typo can be fixed instead
    // of retyped from the transcript.
    await expect.poll(ui.composer).toContain("deploy the prod database by mistake");
  } finally {
    run.mockRestore();
    ui.cleanup();
  }
}, 15000);

it("lists pending messages and withdraws the selected one", async () => {
  const ui = await harness({
    pendingInputs: [
      { id: "p1", content: "wrong queued task", delivery: "queue" },
      { id: "p2", content: "another steered note", delivery: "steer" },
    ],
  });
  try {
    await expect.poll(() => ui.frame(), { timeout: 5000 }).toContain("previous answer");
    ui.type("/pending");
    await expect.poll(ui.composer).toContain("/pending");
    ui.press("\r");
    await expect.poll(() => ui.frame()).toContain("wrong queued task");
    await expect.poll(() => ui.frame()).toContain("Enter 撤回");
    // The second row is selectable, and withdrawing renumbers the list.
    ui.press("\u001b[B");
    await new Promise((resolve) => setTimeout(resolve, 80));
    ui.press("\r");
    await expect.poll(async () => (await ui.store.load(ui.session.id, ui.config.project))?.pendingInputs?.map((item) => item.content))
      .toEqual(["wrong queued task"]);
    await expect.poll(() => ui.frame()).toContain("已撤回待处理消息");
    // One row left: the count in the dialog header proves the steered note is gone.
    await expect.poll(() => ui.frame()).toContain("Pending · Enter 撤回 · 1 条");
    await expect.poll(() => ui.frame()).toContain("1. wrong queued task");
    // Esc closes the list without touching the remaining message.
    ui.press("\u001b");
    await expect.poll(() => ui.frame()).not.toContain("Enter 撤回");
    expect((await ui.store.load(ui.session.id, ui.config.project))?.pendingInputs).toHaveLength(1);
  } finally {
    ui.cleanup();
  }
}, 15000);

it("withdraws a queued task while a run is still going", async () => {
  const ui = await harness();
  const run = vi.spyOn(AgentRunner.prototype, "run").mockImplementation(async (_messages, _mode, signal, _events, _approve, _persist, inbox) => {
    await inbox!.enqueue("wrong queued task", "queue");
    return new Promise((_resolve, reject) => {
      const abort = () => reject(signal.reason);
      if (signal.aborted) abort();
      else signal.addEventListener("abort", abort, { once: true });
    }) as never;
  });
  try {
    await expect.poll(() => ui.frame(), { timeout: 5000 }).toContain("previous answer");
    ui.type("start the long task");
    await expect.poll(ui.composer).toContain("start the long task");
    ui.press("\r");
    await expect.poll(() => ui.frame(), { timeout: 8000 }).toContain("补充指令 · /queue 排队 · Esc 中断");
    await expect.poll(async () => (await ui.store.load(ui.session.id, ui.config.project))?.pendingInputs).toHaveLength(1);
    // The list is reachable mid-run, which is when a bad queue entry is noticed.
    ui.type("/pending");
    await expect.poll(ui.composer).toContain("/pending");
    ui.press("\r");
    await expect.poll(() => ui.frame(), { timeout: 8000 }).toContain("wrong queued task");
    ui.press("\r");
    await expect.poll(async () => (await ui.store.load(ui.session.id, ui.config.project))?.pendingInputs).toEqual([]);
    await expect.poll(() => ui.frame()).toContain("已撤回待处理消息");
  } finally {
    run.mockRestore();
    ui.cleanup();
  }
}, 20000);
