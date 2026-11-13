import React from "react";
import { PassThrough } from "node:stream";
import { stripVTControlCharacters } from "node:util";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { render } from "ink";
import { expect, it, vi } from "vitest";
import { AgentRunner } from "../core/agent.js";
import { loadConfig } from "../core/config.js";
import type { ChatMessage } from "../core/types.js";
import { ApprovalBroker } from "../web/approval.js";
import { QuestionBroker } from "../web/question.js";
import { App } from "./app.js";

/**
 * A task started in the terminal is invisible to the phone, which is the bug
 * this covers: the question is published to the web broker, so a phone watching
 * the same session can answer it and the terminal dialog closes.
 */
const question = { question: "用哪个数据库？", options: [{ label: "Postgres" }, { label: "SQLite" }] };

const harness = async (kind: "question" | "approval" = "question"): Promise<{
  home: string; workspace: string; questions: QuestionBroker;
  frame: () => string; stdin: PassThrough; dispose: () => Promise<void>; unmount: () => void;
  unmountRun: () => void;
}> => {
  const home = await mkdtemp(join(tmpdir(), "luban-question-bridge-"));
  const workspace = join(home, "workspace");
  await mkdir(workspace);
  const config = { ...loadConfig({ workspace }), home };
  const questions = new QuestionBroker();
  const approvals = new ApprovalBroker();
  // What the run actually received: the frame only proves the dialog closed.
  const answers: string[] = [];
  const decisions: string[] = [];
  const run = vi.spyOn(AgentRunner.prototype, "run").mockImplementation(async (
    messages: ChatMessage[], _mode, _signal, _onEvent, approve, _persist, _inbox, askUser,
  ) => {
    if (kind === "approval") {
      // Approval-only run: the tool call is what asks the human.
      decisions.push(await approve({ name: "bash", risk: "execute", description: "运行命令" } as never, { command: "ls" }));
      return { ok: true, text: "已批准", steps: 1, modelCalls: 1, elapsedMs: 1, messages };
    }
    const answer = await askUser!(question, new AbortController().signal);
    answers.push(answer);
    return { ok: true, text: `选择了 ${answer}`, steps: 1, modelCalls: 1, elapsedMs: 1, messages };
  });
  const stdin = Object.assign(new PassThrough(), { isTTY: true, setRawMode() {}, ref() {}, unref() {} });
  const stdout = Object.assign(new PassThrough(), { columns: 120, rows: 40, isTTY: true });
  let raw = "";
  stdout.on("data", data => { raw += String(data); });
  const app = render(<App config={config} questions={questions} approvals={approvals} />, {
    stdin: stdin as unknown as NodeJS.ReadStream, stdout: stdout as unknown as NodeJS.WriteStream,
    debug: true, patchConsole: false, exitOnCtrlC: false,
  });
  return {
    home, workspace, questions, approvals, answers, decisions, stdin,
    frame: () => stripVTControlCharacters(raw),
    unmount: () => { app.unmount(); app.cleanup(); run.mockRestore(); },
    dispose: async () => { await rm(home, { recursive: true, force: true, maxRetries: 20, retryDelay: 25 }); },
  };
};

it("lets a phone answer the question the terminal is showing", async () => {
  const test = await harness();
  try {
    await expect.poll(() => test.frame()).toContain("Message luban");
    test.stdin.write("选数据库");
    await expect.poll(() => test.frame()).toContain("选数据库");
    test.stdin.write("\r");
    await expect.poll(() => test.frame()).toContain("用哪个数据库？");
    // The phone polls /api/questions; it sees the terminal's question as soon as
    // the dialog appears, and answering there releases the terminal run.
    await expect.poll(() => test.questions.pending()).toHaveLength(1);
    const pending = test.questions.pending()[0]!;
    expect(pending.question).toBe("用哪个数据库？");
    expect(pending.options.map(option => option.label)).toEqual(["Postgres", "SQLite"]);
    expect(test.questions.answer(pending.id, "SQLite")).toBe(true);
    await expect.poll(() => test.answers).toEqual(["SQLite"]);
    await expect.poll(() => test.frame()).toContain("任务已完成");
    expect(test.questions.pending()).toEqual([]);
  } finally {
    test.unmount();
    await test.dispose();
  }
}, 15_000);

it("withdraws the phone copy when the terminal answers first", async () => {
  const test = await harness();
  try {
    await expect.poll(() => test.frame()).toContain("Message luban");
    test.stdin.write("选数据库");
    await expect.poll(() => test.frame()).toContain("选数据库");
    test.stdin.write("\r");
    await expect.poll(() => test.questions.pending()).toHaveLength(1);
    // The dialog numbers its options; 1 picks Postgres.
    test.stdin.write("1");
    await expect.poll(() => test.answers).toEqual(["Postgres"]);
    expect(test.questions.pending()).toEqual([]);
    await expect.poll(() => test.frame()).toContain("任务已完成");
  } finally {
    test.unmount();
    await test.dispose();
  }
}, 15_000);

it("lets a phone decide an approval the terminal is showing", async () => {
  const test = await harness("approval");
  try {
    await expect.poll(() => test.frame()).toContain("Message luban");
    test.stdin.write("跑个命令");
    await expect.poll(() => test.frame()).toContain("跑个命令");
    test.stdin.write("\r");
    await expect.poll(() => test.approvals.pending()).toHaveLength(1);
    const pending = test.approvals.pending()[0]!;
    expect(pending.tool).toBe("bash");
    expect(test.approvals.decide(pending.id, "deny")).toBe(true);
    await expect.poll(() => test.decisions).toEqual(["deny"]);
    expect(test.approvals.pending()).toEqual([]);
  } finally {
    test.unmount();
    await test.dispose();
  }
}, 15_000);
