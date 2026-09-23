import React from "react";
import { PassThrough } from "node:stream";
import { stripVTControlCharacters } from "node:util";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { render } from "ink";
import { expect, it, vi } from "vitest";
import { loadConfig } from "../core/config.js";
import { AgentRunner } from "../core/agent.js";
import type { MeshRuntime, MeshEvent, MeshJob } from "../core/mesh/runtime.js";
import { App } from "./app.js";

it.each([{ columns: 80, rows: 24 }, { columns: 120, rows: 30 }])("keeps local prompts and replies visible with mesh traffic at $columns x $rows", async ({ columns, rows }) => {
  const home = await mkdtemp(join(tmpdir(), "luban-mesh-ui-"));
  const oldHome = process.env.LUBAN_HOME;
  process.env.LUBAN_HOME = home;
  const config = loadConfig({ workspace: home });
  let notify: (event: MeshEvent) => void = () => {};
  const chats = Array.from({ length: 20 }, (_, i) => ({
    id: `chat-${i}`, from: "peer-device", to: config.mesh.nodeName,
    text: `remote-message-${i}\nsecond line\nthird line`, received_at: 1000 - i,
  }));
  const job: MeshJob = {
    id: "remote-job", source: "peer-device", target: config.mesh.nodeName,
    kind: "agent", project_id: config.project, workspace: home, instruction: "remote task",
    title: "remote task", status: "working", progress: 0, logs: [], result: "", error: "",
    created_at: Date.now() / 1000, updated_at: Date.now() / 1000, done_at: null, log_offset: 0,
  };
  const mesh = {
    peers: () => [], chats: async () => chats, jobs: async () => [job],
    jobStream: () => ({ events: [] }),
    onEvent: (listener: typeof notify) => { notify = listener; return () => {}; },
  } as unknown as MeshRuntime;
  let finish!: () => void;
  const gate = new Promise<void>(resolve => { finish = resolve; });
  const run = vi.spyOn(AgentRunner.prototype, "run").mockImplementation(async (messages, _mode, _signal, onEvent) => {
    onEvent({ type: "delta", text: "local-streaming-answer" });
    await gate;
    messages.push({ role: "assistant", content: "local-final-answer" });
    return { ok: true, text: "local-final-answer", steps: 1, modelCalls: 1, elapsedMs: 100, messages };
  });
  const stdin = Object.assign(new PassThrough(), { isTTY: true, setRawMode() {}, ref() {}, unref() {} });
  const stdout = Object.assign(new PassThrough(), { columns, rows, isTTY: true });
  let frame = "";
  stdout.on("data", data => { const text = stripVTControlCharacters(String(data)); if (text.includes("Auto")) frame = text; });
  const app = render(<App config={config} mesh={mesh} />, {
    stdin: stdin as unknown as NodeJS.ReadStream, stdout: stdout as unknown as NodeJS.WriteStream,
    debug: true, patchConsole: false, exitOnCtrlC: false,
  });
  const send = async (text: string) => {
    stdin.write(text);
    await expect.poll(() => frame, { timeout: 3000 }).toContain("\u276f " + text);
    stdin.write("\r");
  };
  try {
    await expect.poll(() => frame, { timeout: 5000 }).toContain("Mesh");
    await send("local-question");
    await expect.poll(() => frame, { timeout: 3000 }).toContain("local-streaming-answer");
    expect(frame).toContain("local-question");
    const message = { ...chats[0]!, id: "incoming", text: "incoming-peer-chat" };
    notify({ type: "chat", from: message.from, text: message.text, message });
    await expect.poll(() => frame).toContain("21 messages");
    expect(frame).toContain("local-question");
    expect(frame).toContain("local-streaming-answer");
    notify({ type: "job", job });
    notify({ type: "job-event", id: job.id, seq: 1, event: { kind: "delta", text: "remote-job-answer" } });
    await expect.poll(() => frame).toContain("1 active");
    expect(frame).toContain("local-streaming-answer");
    expect(frame.match(/local-question/g)).toHaveLength(2);
    await send("/mesh");
    await expect.poll(() => frame).toContain("remote-job-answer");
    await send("/mesh");
    await expect.poll(() => frame).toContain("local-streaming-answer");
    finish();
    await expect.poll(() => frame).toContain("local-final-answer");
    await expect.poll(() => frame, { timeout: 5000 }).toContain("Auto \u276f");
    expect(frame).toContain("local-question");
    expect(frame.split("\n").length).toBeLessThanOrEqual(rows + 1);
    await send("/mesh");
    await expect.poll(() => frame).toContain("remote-job-answer");
    await send("/mesh");
    await expect.poll(() => frame).toContain("local-final-answer");
    await send("/jobs remote-job");
    await expect.poll(() => frame).toContain("remote-job-answer");
    await send("next-local-question");
    await expect.poll(() => frame).toContain("local-final-answer");
    expect(frame).toContain("next-local-question");
    await expect.poll(() => run.mock.calls.length).toBe(2);
  } finally {
    finish();
    app.unmount(); app.cleanup(); run.mockRestore();
    if (oldHome === undefined) delete process.env.LUBAN_HOME;
    else process.env.LUBAN_HOME = oldHome;
  }
}, 20000);
