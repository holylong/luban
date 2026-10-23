import React from "react";
import { PassThrough } from "node:stream";
import { stripVTControlCharacters } from "node:util";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { render } from "ink";
import { expect, it, vi } from "vitest";
import { AgentRunner } from "../core/agent.js";
import { loadConfig } from "../core/config.js";
import { SessionStore } from "../core/session-store.js";
import type { ChatMessage } from "../core/types.js";
import { App } from "./app.js";

it.each(["exit", "continue"])("refreshes SSH progress before the old terminal submits %s", async action => {
  const home = await mkdtemp(join(tmpdir(), "luban-ui-session-concurrency-"));
  const oldHome = process.env.LUBAN_HOME; process.env.LUBAN_HOME = home;
  const workspace = join(home, "workspace"); await mkdir(workspace);
  const config = loadConfig({ workspace });
  const store = new SessionStore(home);
  const record = store.create(config.project, workspace, "auto", config.model.id, [
    { role: "user", content: "Original office task" }, { role: "assistant", content: "Original office answer" },
  ]);
  record.titleSource = "model"; record.title = "Shared session";
  await store.save(record);
  let request: ChatMessage[] = [];
  const run = vi.spyOn(AgentRunner.prototype, "run").mockImplementation(async messages => {
    request = structuredClone(messages);
    messages.push({ role: "assistant", content: "Continued with SSH progress" });
    return { ok: true, text: "Continued with SSH progress", steps: 1, messages, modelCalls: 1, elapsedMs: 1 };
  });
  const stdin = Object.assign(new PassThrough(), { isTTY: true, setRawMode() {}, ref() {}, unref() {} });
  const stdout = Object.assign(new PassThrough(), { columns: 120, rows: 40, isTTY: true });
  let frame = "";
  stdout.on("data", data => { frame = stripVTControlCharacters(String(data)); });
  const app = render(<App config={config} resume={record.id} />, {
    stdin: stdin as unknown as NodeJS.ReadStream, stdout: stdout as unknown as NodeJS.WriteStream,
    debug: true, patchConsole: false, exitOnCtrlC: false,
  });
  try {
    await expect.poll(() => frame).toContain("Resumed Shared session");
    const sshStore = new SessionStore(home);
    const ssh = (await sshStore.load(record.id, config.project, workspace))!;
    ssh.messages.push({ role: "user", content: "Work from home over SSH" }, { role: "assistant", content: "New SSH result" });
    ssh.messages.push({ role: "system", content: '[luban task plan]\n{"plan":[{"step":"SSH follow-up","status":"pending"}]}' });
    ssh.edits = [{ id: "ssh-edit", name: "edit_file", preview: "Edited src/home.ts (+1 -1)\n     2 -before SSH\n     2 +after SSH" }];
    ssh.pendingInputs = [{ id: "ssh-queue", content: "Queued at home", delivery: "queue", createdAt: ssh.updatedAt }];
    await sshStore.save(ssh);
    const text = action === "exit" ? "/exit" : "Continue at office";
    stdin.write(text); await expect.poll(() => frame).toContain(text); stdin.write("\r");
    if (action === "exit") await app.waitUntilExit();
    else {
      await expect.poll(() => frame).toContain("Continued with SSH progress");
      expect(request.map(message => message.content)).toContain("New SSH result");
      expect(request.at(-1)?.content).toBe("Continue at office");
      expect(frame).toContain("SSH follow-up");
      expect(frame).toContain("src/home.ts");
    }
    const reopened = (await new SessionStore(home).load("latest", config.project, workspace))!;
    expect(reopened.id).toBe(record.id);
    expect(reopened.messages.map(message => message.content)).toContain("New SSH result");
    expect(reopened.edits).toEqual(ssh.edits);
    expect(reopened.pendingInputs).toEqual(ssh.pendingInputs);
    if (action === "exit") expect(run).not.toHaveBeenCalled();
  } finally {
    app.unmount(); app.cleanup(); run.mockRestore();
    if (oldHome === undefined) delete process.env.LUBAN_HOME; else process.env.LUBAN_HOME = oldHome;
    await rm(home, { recursive: true, force: true });
  }
}, 15_000);
