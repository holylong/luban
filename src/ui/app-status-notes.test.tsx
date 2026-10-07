import React from "react";
import { PassThrough } from "node:stream";
import { createServer, type Server } from "node:http";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
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
 * A run whose model keeps calling tools is the case that produced the noise: the
 * runtime re-announces "Reviewing tool results" after every single step, so
 * recording status events as transcript notes stacked one identical line per
 * step. The label still belongs on the working line, so the assertion is on the
 * finished transcript — by then the working line is gone and everything left is
 * durable record.
 *
 * The first request answers 429 to prove the flag is a filter and not a blanket
 * "drop status events": the retry notice is exactly the kind of line whose only
 * surviving trace is the transcript.
 */
it("keeps repeated step progress out of the finished transcript but keeps real notices", async () => {
  const home = await mkdtemp(join(tmpdir(), "luban-status-notes-"));
  const workspace = join(home, "workspace");
  await mkdir(workspace);
  const STEPS = 6;
  await Promise.all(Array.from({ length: STEPS }, (_, index) =>
    writeFile(join(workspace, `note-${index}.txt`), `hello ${index}\n`)));

  let turn = 0;
  server = createServer((request, response) => {
    request.on("data", () => {});
    request.on("end", () => {
      turn += 1;
      // 429 once, so the client's retry notice travels the same path as progress.
      if (turn === 1) {
        response.writeHead(429, { "content-type": "application/json", "retry-after": "0" });
        response.end('{"error":"slow down"}');
        return;
      }
      response.writeHead(200, { "content-type": "text/event-stream" });
      const step = turn - 1;
      if (step <= STEPS) {
        // A different file each step, or the repeated-call guard stops the run.
        const args = JSON.stringify({ path: `note-${step - 1}.txt` }).replaceAll('"', '\\"');
        response.write(`data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"c${step}","function":{"name":"read_file","arguments":"${args}"}}]}}]}\n\n`);
      } else {
        response.write('data: {"choices":[{"delta":{"content":"全部文件已读取。"}}]}\n\n');
      }
      response.write('data: {"choices":[],"usage":{"prompt_tokens":1,"completion_tokens":1}}\n\n');
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
  config.maxSteps = 20;
  const store = new SessionStore(home);
  const session = store.create(config.project, workspace, "auto", config.model.id, []);

  const stdin = Object.assign(new PassThrough(), { isTTY: true, setRawMode() {}, ref() {}, unref() {} });
  const stdout = Object.assign(new PassThrough(), { columns: 110, rows: 80, isTTY: true });
  let frame = "";
  stdout.on("data", (data) => {
    const text = stripVTControlCharacters(String(data));
    // Frames are written whole in debug mode; keep the newest one that has the
    // composer, which is every full frame.
    if (text.includes("Auto ❯") || text.includes("Auto ")) frame = text;
  });

  const app = render(<App config={config} resume={session.id} initialPrompt="read every note file" />, {
    stdin: stdin as unknown as NodeJS.ReadStream, stdout: stdout as unknown as NodeJS.WriteStream,
    debug: true, patchConsole: false, exitOnCtrlC: false,
  });
  try {
    await expect.poll(() => frame, { timeout: 30000 }).toContain("已完成");
    // Let the post-run render settle so the working line is gone.
    await new Promise((resolve) => setTimeout(resolve, 150));

    expect(turn).toBeGreaterThan(STEPS);
    // The durable record: one entry, no matter how many steps re-announced it.
    expect(frame).not.toContain("Reviewing tool results");
    // The retry notice is not progress, so it still has to be in the record.
    expect(frame).toContain("429");
    // A past retry is part of the scrolled transcript, never a pinned row in
    // the composer below the current answer.
    const composer = frame.lastIndexOf("Auto ❯");
    expect(composer).toBeGreaterThan(0);
    expect(frame.slice(composer)).not.toContain("429");
    // The run really did work through several steps.
    expect(frame.match(/note-\d\.txt/g)?.length ?? 0).toBeGreaterThan(1);
  } finally {
    app.unmount();
    app.cleanup();
    await new Promise<void>((resolve) => server ? server.close(() => resolve()) : resolve());
    if (oldHome === undefined) delete process.env.LUBAN_HOME; else process.env.LUBAN_HOME = oldHome;
  }
}, 60000);
