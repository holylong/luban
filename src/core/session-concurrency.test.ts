import { describe, expect, it, vi } from "vitest";
import { spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { SessionConflictError, SessionStore } from "./session-store.js";
import { SessionHistory } from "./session-history.js";

async function fixture() {
  const home = await mkdtemp(join(tmpdir(), "luban-session-concurrency-"));
  const store = new SessionStore(home);
  const record = store.create("demo", home, "auto", "test/model", [
    { role: "user", content: "Office task" }, { role: "assistant", content: "Office answer" },
  ]);
  await store.save(record);
  return { home, store, record, path: join(store.root, "demo", `${record.id}.json`) };
}

function message(child: ChildProcess, type: string): Promise<Record<string, string>> {
  return new Promise((resolveMessage, reject) => {
    const timer = setTimeout(() => finish(new Error(`child did not send ${type}`)), 10_000);
    const onMessage = (value: unknown) => {
      const data = value as Record<string, string>;
      if (data.type === type) finish(undefined, data);
    };
    const onExit = (code: number | null) => finish(new Error(`child exited before ${type}: ${code}`));
    const finish = (error?: Error, data?: Record<string, string>) => {
      clearTimeout(timer); child.off("message", onMessage); child.off("exit", onExit); child.off("error", finish);
      if (error) reject(error); else resolveMessage(data!);
    };
    child.on("message", onMessage); child.once("exit", onExit); child.once("error", finish);
  });
}

function worker(script: string, home: string, id: string, label = ""): ChildProcess {
  return spawn(process.execPath, ["--import", "tsx", "--input-type=module", "-e", script], {
    env: { ...process.env, SESSION_TEST_HOME: home, SESSION_TEST_ID: id, SESSION_TEST_LABEL: label },
    stdio: ["ignore", "ignore", "pipe", "ipc"],
  });
}

const storeModule = JSON.stringify(pathToFileURL(resolve("src/core/session-store.ts")).href);
const lockModule = JSON.stringify(pathToFileURL(resolve("src/core/session-lock.ts")).href);

describe("multi-process session persistence", () => {
  it("keeps SSH progress when the stale office terminal saves its exit or late title", async () => {
    const f = await fixture();
    try {
      const ssh = (await new SessionStore(f.home).load(f.record.id, "demo"))!;
      ssh.messages.push({ role: "user", content: "SSH work" }, { role: "assistant", content: "SSH result" });
      ssh.pendingInputs = [{ id: "queued", content: "Next task", delivery: "queue", createdAt: ssh.updatedAt }];
      ssh.edits = [{ id: "edit", name: "edit_file", preview: "Edited a.ts (+1 -1)\n 1 -old\n 1 +new" }];
      await new SessionStore(f.home).save(ssh);
      const saved = await readFile(f.path, "utf8");
      f.record.inputHistory = ["/exit"];
      f.record.title = "Late office title"; f.record.titleSource = "model";
      await f.store.save(f.record);
      await f.store.save(f.record);
      expect(await readFile(f.path, "utf8")).toBe(saved);
      const latest = (await f.store.load("latest", "demo"))!;
      expect(latest.messages.at(-1)?.content).toBe("SSH result");
      expect(latest.pendingInputs).toEqual(ssh.pendingInputs);
      expect(latest.edits).toEqual(ssh.edits);
      const refreshed = (await f.store.refresh(f.record))!;
      expect(refreshed.messages).toEqual(ssh.messages);
      expect(await f.store.refresh(refreshed)).toBeUndefined();
    } finally { await rm(f.home, { recursive: true, force: true }); }
  });

  it("does not make an older session latest just by saving command history or a title", async () => {
    const f = await fixture();
    const clock = vi.spyOn(Date, "now").mockReturnValue(Date.parse(f.record.updatedAt) + 1000);
    try {
      const originalTime = f.record.updatedAt;
      const ssh = f.store.create("demo", f.home, "auto", "test/model", [{ role: "user", content: "Separate SSH task" }]);
      await f.store.save(ssh);
      f.record.inputHistory = ["/status", "/exit"];
      f.record.title = "Named later"; f.record.titleSource = "model";
      await f.store.save(f.record);
      expect(f.record.updatedAt).toBe(originalTime);
      expect((await f.store.load("latest", "demo"))?.id).toBe(ssh.id);
      expect((await f.store.load(f.record.id, "demo"))?.inputHistory).toEqual(["/status", "/exit"]);
    } finally { clock.mockRestore(); await rm(f.home, { recursive: true, force: true }); }
  });

  it("rejects divergent stale writes even when the new transcript was compacted", async () => {
    const f = await fixture();
    try {
      const ssh = (await f.store.load(f.record.id, "demo"))!;
      ssh.messages = [{ role: "user", content: "Compacted SSH progress" }];
      await f.store.save(ssh);
      f.record.messages.push({ role: "user", content: "Divergent office task" });
      await expect(f.store.save(f.record)).rejects.toBeInstanceOf(SessionConflictError);
      expect((await f.store.load(f.record.id, "demo"))?.messages).toEqual(ssh.messages);
      expect(f.record.messages.at(-1)?.content).toBe("Divergent office task");
    } finally { await rm(f.home, { recursive: true, force: true }); }
  });

  it("mirrors only committed snapshots and leaves the newer mirror untouched on stale saves", async () => {
    const f = await fixture();
    const history = SessionHistory.open({ enabled: true, directory: "", maxMessagesPerSession: 0 }, f.home)!;
    const append = vi.spyOn(history, "append");
    const store = new SessionStore(f.home, history);
    try {
      const ssh = (await store.load(f.record.id, "demo"))!;
      ssh.messages.push({ role: "assistant", content: "Mirrored SSH progress" });
      await store.save(ssh);
      expect(history.messages(ssh.id).at(-1)?.content).toBe("Mirrored SSH progress");
      await store.save(f.record);
      expect(append).toHaveBeenCalledTimes(1);
      expect(history.messages(ssh.id)).toEqual(ssh.messages);
    } finally { history.close(); await rm(f.home, { recursive: true, force: true }); }
  });

  it("admits only one of two real processes writing from the same baseline", async () => {
    const f = await fixture();
    const script = `import { SessionStore } from ${storeModule};
      const store = new SessionStore(process.env.SESSION_TEST_HOME);
      const record = await store.load(process.env.SESSION_TEST_ID, 'demo');
      process.on('message', async () => {
        record.messages.push({role:'user',content:process.env.SESSION_TEST_LABEL});
        try { await store.save(record); process.send({type:'result',status:'saved'}); }
        catch (error) { process.send({type:'result',status:error.name}); }
        process.disconnect();
      }); process.send({type:'ready'});`;
    const children = [worker(script, f.home, f.record.id, "office"), worker(script, f.home, f.record.id, "ssh")];
    try {
      await Promise.all(children.map(child => message(child, "ready")));
      const results = children.map(child => message(child, "result"));
      const exits = children.map(child => once(child, "exit"));
      for (const child of children) child.send("save");
      expect((await Promise.all(results)).map(result => result.status).sort()).toEqual(["SessionConflictError", "saved"]);
      await Promise.all(exits);
      const stored = (await f.store.load(f.record.id, "demo"))!;
      expect(stored.messages).toHaveLength(3);
      expect(["office", "ssh"]).toContain(stored.messages.at(-1)?.content);
      expect(await readdir(join(f.store.root, "demo"))).toEqual([`${f.record.id}.json`]);
    } finally { for (const child of children) child.kill(); await rm(f.home, { recursive: true, force: true }); }
  }, 20_000);

  it("recovers a lock left by a terminated writer", async () => {
    const f = await fixture();
    const script = `import { withSessionLock } from ${lockModule};
      import { join } from 'node:path';
      await withSessionLock(join(process.env.SESSION_TEST_HOME,'sessions-node','demo',process.env.SESSION_TEST_ID+'.json'), async () => {
        process.send({type:'locked'}); await new Promise(() => {setInterval(() => {},1000);});
      });`;
    const child = worker(script, f.home, f.record.id);
    try {
      await message(child, "locked");
      const exited = once(child, "exit"); child.kill("SIGKILL"); await exited;
      f.record.messages.push({ role: "user", content: "Resumed after crash" });
      await f.store.save(f.record);
      expect((await f.store.load(f.record.id, "demo"))?.messages.at(-1)?.content).toBe("Resumed after crash");
    } finally { child.kill(); await rm(f.home, { recursive: true, force: true }); }
  }, 20_000);
});
