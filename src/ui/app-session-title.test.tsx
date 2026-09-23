import React from "react";
import { PassThrough } from "node:stream";
import { createServer, type Server } from "node:http";
import { mkdir, mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { stripVTControlCharacters } from "node:util";
import { render } from "ink";
import { expect, it } from "vitest";
import { loadConfig } from "../core/config.js";
import { SessionStore } from "../core/session-store.js";
import { App } from "./app.js";

let server: Server | undefined;

/**
 * A session opened with "继续" is the case that made titles useless: the first
 * line of the opening user message says nothing about the work, and it stayed
 * that way forever because every save re-derived the title from it. So the test
 * drives a real run through a fake model and asserts two things: the header ends
 * up showing the name the model wrote, and the record on disk keeps it — the
 * second is the one that used to regress, because the post-run save recomputed
 * the title from the transcript.
 */
it("names a session from the model's summary and keeps that name across saves", async () => {
  const home = await mkdtemp(join(tmpdir(), "luban-session-title-"));
  const workspace = join(home, "workspace");
  await mkdir(workspace);
  const TITLE = "修复解析器内存泄漏";

  server = createServer((request, response) => {
    let raw = "";
    request.on("data", (chunk) => { raw += String(chunk); });
    request.on("end", () => {
      const body = JSON.parse(raw) as { messages: Array<{ content?: string }> };
      const naming = JSON.stringify(body.messages[0]?.content ?? "").includes("You name coding sessions");
      response.writeHead(200, { "content-type": "text/event-stream" });
      // The naming call is a separate, tool-free round trip after the run; the
      // run itself answers directly so the whole test stays two requests.
      const content = naming ? TITLE : "已按上次的结论继续修复解析器。";
      response.write(`data: {"choices":[{"delta":{"content":"${content}"}}]}\n\n`);
      response.write('data: {"choices":[],"usage":{"prompt_tokens":10,"completion_tokens":5}}\n\n');
      response.end("data: [DONE]\n\n");
    });
  });
  await new Promise<void>((resolve) => server!.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("no test address");

  const oldHome = process.env.LUBAN_HOME;
  process.env.LUBAN_HOME = home;
  const config = loadConfig({ workspace });
  config.model = { ...config.model, baseUrl: `http://127.0.0.1:${address.port}/v1`, apiKey: "" };
  config.permissionMode = "allow";
  const store = new SessionStore(home);
  // What the session is called before any model has seen it: the opening line.
  expect(store.create(config.project, workspace, "auto", config.model.id, []).title).toBe("New session");

  const stdin = Object.assign(new PassThrough(), { isTTY: true, setRawMode() {}, ref() {}, unref() {} });
  const stdout = Object.assign(new PassThrough(), { columns: 110, rows: 40, isTTY: true });
  let frame = "";
  stdout.on("data", (data) => {
    const text = stripVTControlCharacters(String(data));
    if (text.includes("Auto")) frame = text;
  });

  // The opening line is deliberately the one word a title cannot be built from.
  const app = render(<App config={config} initialPrompt="继续" />, {
    stdin: stdin as unknown as NodeJS.ReadStream, stdout: stdout as unknown as NodeJS.WriteStream,
    debug: true, patchConsole: false, exitOnCtrlC: false,
  });
  try {
    await expect.poll(() => frame, { timeout: 30000 }).toContain("已完成");
    // The header carries the name the model wrote, not the opening line.
    await expect.poll(() => frame, { timeout: 30000 }).toContain(TITLE);
    // What matters is the record on disk: the header can be right while the
    // save path quietly recomputes the title from the transcript.
    await expect.poll(async () => (await store.list())[0]?.title, { timeout: 30000 }).toBe(TITLE);
    const stored = (await store.list())[0]!;
    // The marker is what stops the next save from putting "继续" back.
    expect(stored.titleSource).toBe("model");
    // The opening line is still in the transcript, it is just not the name.
    expect(stored.messages.find((message) => message.role === "user")?.content).toBe("继续");
    expect(stored.messages.at(-1)?.content).toContain("已按上次的结论");
  } finally {
    app.unmount();
    app.cleanup();
    await new Promise<void>((resolve) => server ? server.close(() => resolve()) : resolve());
    if (oldHome === undefined) delete process.env.LUBAN_HOME; else process.env.LUBAN_HOME = oldHome;
  }
}, 60000);
