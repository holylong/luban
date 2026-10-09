import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { once } from "node:events";
import { afterEach, describe, expect, it } from "vitest";
import type { LubanConfig } from "../types.js";
import type { JsonObject } from "./protocol.js";
import { MeshRuntime, type MeshEvent } from "./runtime.js";

const roots: string[] = [];

function config(root: string, name: string): LubanConfig {
  const workspace = join(root, "workspace");
  return {
    home: join(root, "home"),
    workspace,
    project: "shared-project",
    model: { id: "test/model", provider: "test", model: "model", name: "model", baseUrl: "http://127.0.0.1", apiKey: "" },
    models: [],
    maxTokens: 1024,
    temperature: 0,
    timeoutMs: 5_000,
    maxSteps: 5,
    backendUrl: "",
    permissionMode: "allow",
    mesh: {
      enabled: true,
      nodeName: name,
      host: "127.0.0.1",
      port: 0,
      udpPort: 0,
      capabilities: ["agent", "nodejs"],
      contacts: [],
      token: "",
      syncMode: "chunk",
      chunkSize: 1024,
      syncIgnore: [".luban", ".git", "node_modules"],
      conflictPolicy: "auto",
      jobsDir: join(root, "home", "jobs"),
      workspacesDir: join(root, "home", "workspaces"),
      projects: {},
      maxWorkers: 1,
      jobTimeoutSeconds: 30,
      queueTimeoutSeconds: 30,
    },
  };
}

async function temporary(name: string): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), `luban-${name}-`));
  roots.push(root);
  return root;
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true, maxRetries: 20, retryDelay: 25 })));
});

describe("MeshRuntime", () => {
  it("keeps an existing instance and its active jobs intact on a port collision", async () => {
    const root = await temporary("multi-instance");
    const first = new MeshRuntime(config(root, "local"));
    const second = new MeshRuntime(config(root, "local"));
    const strict = new MeshRuntime(config(root, "local"));
    try {
      await first.start();
      const active = await first.store.create({ source: "peer", target: "local", instruction: "in progress", status: "working", runtime: "nodejs", instance_id: "other-live-instance" });
      second.config.mesh.port = first.config.mesh.port;
      strict.config.mesh.port = first.config.mesh.port;
      await expect(strict.start()).rejects.toMatchObject({ code: "EADDRINUSE" });
      expect(strict.isServing()).toBe(false);
      await second.start({ allowPortFallback: true });
      expect(second.isServing()).toBe(true);
      expect(second.config.mesh.port).not.toBe(first.config.mesh.port);
      expect(second.config.mesh.nodeName).not.toBe(first.config.mesh.nodeName);
      expect(second.store.directory).not.toBe(first.store.directory);
      expect((await first.store.get(active.id))?.status).toBe("working");
      await second.addContact({ name: "local", host: "127.0.0.1", port: first.config.mesh.port, udpPort: first.config.mesh.udpPort, note: "" });
      await expect(second.ping("local")).resolves.toContain("reachable");
      await second.stop();
      expect(first.isServing()).toBe(true);
    } finally {
      await Promise.all([first.stop(), second.stop(), strict.stop()]);
    }
  });

  it("returns paused remote jobs promptly with their summary instead of failure", async () => {
    const alpha = new MeshRuntime(config(await temporary("pause-a"), "alpha"));
    const beta = new MeshRuntime(config(await temporary("pause-b"), "beta"));
    beta.setJobRunner(async () => ({ ok: false, stopReason: "max_steps", text: "First file updated; tests remain." }));
    await mkdir(beta.config.workspace, { recursive: true });
    await writeFile(join(beta.config.workspace, "input.txt"), "task context");
    try {
      await Promise.all([alpha.start(), beta.start()]);
      await alpha.addContact({ name: "beta", host: "127.0.0.1", port: beta.config.mesh.port, udpPort: beta.config.mesh.udpPort, note: "" });
      const result = await alpha.handoff("beta", "work", "shared-project", 30);
      expect(result).toContain(": paused");
      expect(result).toContain("tests remain");
      const job = (await beta.jobs())[0]!;
      expect(job.status).toBe("paused");
      expect(job.error).toBe("");
      expect(job.result).toContain("tests remain");
      await beta.store.update(job.id, { session_id: "test-history" });
      alpha.config.mesh.nodeName = "unrelated-node";
      await expect(alpha.resumeRemoteJob("beta", job.id)).rejects.toThrow("only the submitting node");
      alpha.config.mesh.nodeName = "alpha";
      beta.setJobRunner(async resumed => {
        expect(resumed.id).toBe(job.id);
        expect(resumed.resume_count).toBe(1);
        return { ok: true, text: "remaining work complete" };
      });
      await expect(alpha.resumeRemoteJob("beta", job.id)).resolves.toContain(job.id);
      await expect.poll(async () => (await beta.store.get(job.id))?.status).toBe("done");
      await expect(alpha.rpc("beta", "job_poll", { job_id: job.id })).resolves.toMatchObject({ status: "done", result: "remaining work complete" });
    } finally {
      await Promise.all([alpha.stop(), beta.stop()]);
    }
  }, 10_000);

  it("mirrors an outbound job's structured stream and keeps a local record", async () => {
    const alpha = new MeshRuntime(config(await temporary("mirror-a"), "alpha"));
    const beta = new MeshRuntime(config(await temporary("mirror-b"), "beta"));
    beta.setJobRunner(async (_job, _signal, onLog, onEvent) => {
      onLog("info", "planning");
      onEvent?.({ kind: "model-call", index: 1 });
      onEvent?.({ kind: "thinking", text: "check the tests first" });
      onEvent?.({ kind: "tool-start", callId: "c1", name: "bash", args: { command: "npm test" }, summary: "npm test" });
      onEvent?.({ kind: "tool-end", callId: "c1", name: "bash", ok: true, elapsedMs: 12, preview: "ok" });
      onEvent?.({ kind: "delta", text: "checks passed" });
      return { ok: true, text: "checks passed" };
    });
    await mkdir(beta.config.workspace, { recursive: true });
    await writeFile(join(beta.config.workspace, "input.txt"), "task context");
    try {
      await Promise.all([alpha.start(), beta.start()]);
      await alpha.addContact({ name: "beta", host: "127.0.0.1", port: beta.config.mesh.port, udpPort: beta.config.mesh.udpPort, note: "" });
      const result = await alpha.handoff("beta", "run the checks", "shared-project", 30);
      const id = /remote job (\S+) on beta/.exec(result)?.[1];
      expect(id).toBeTruthy();
      // The submitting node owns a record of what it handed off, so local views
      // can list the job instead of showing nothing until the peer replies.
      expect(await alpha.store.get(id!)).toMatchObject({
        source: "alpha", target: "beta", status: "done", instruction: "run the checks", result: "checks passed",
      });
      // And it holds the peer's structured events, not just its log text: a
      // terminal cannot render a remote run from "bash: done" alone.
      const { events } = alpha.jobStream(id!);
      expect(events.map((entry) => entry.event.kind)).toEqual(
        expect.arrayContaining(["model-call", "thinking", "tool-start", "tool-end", "delta"]));
      expect(events.find((entry) => entry.event.kind === "tool-start")?.event).toMatchObject({ name: "bash", summary: "npm test" });
      expect(events.at(-1)?.event).toMatchObject({ kind: "delta", text: "checks passed" });
    } finally {
      await Promise.all([alpha.stop(), beta.stop()]);
    }
  }, 15_000);

  it("answers a sync request that outlives the socket idle timeout instead of dropping the reply", async () => {
    // Regression: handleSocket used to destroy any socket idle for 60s, so a slow
    // workspace sync (large tree, Windows over SMB) was killed mid-handler and its
    // reply was silently discarded — the caller only saw "connected but no reply".
    const [rootA, rootB] = await Promise.all([temporary("idle-a"), temporary("idle-b")]);
    const configA = config(rootA, "alpha");
    const configB = config(rootB, "beta");
    await Promise.all([mkdir(configA.workspace, { recursive: true }), mkdir(configB.workspace, { recursive: true })]);

    const beta = new MeshRuntime(configB);
    // Shrink the ceiling so the test needs milliseconds rather than minutes.
    beta.socketIdleTimeoutMs = 150;
    await beta.start();
    try {
      const alpha = new MeshRuntime(configA);
      await alpha.start();
      try {
        const { createConnection } = await import("node:net");
        const { encodeFrame, envelope, decodeFrames } = await import("./protocol.js");
        // A sync handler that blocks for well past the idle ceiling.
        const slow = beta as unknown as { handleMessage: (m: JsonObject) => Promise<JsonObject> };
        const original = slow.handleMessage.bind(beta);
        beta.handleMessage = async (message: JsonObject) => {
          if (message.type === "sync_request") await new Promise((r) => setTimeout(r, 900));
          return original(message);
        };

        const request = envelope("sync_request", "alpha", "", {
          project_id: configB.project, mode: "chunk", files: {},
        });
        request.expect_reply = true;
        const port = configB.mesh.port;
        const reply = await new Promise<JsonObject>((resolveReply, rejectReply) => {
          const sock = createConnection({ host: "127.0.0.1", port });
          const started = Date.now();
          let buffer = Buffer.alloc(0);
          sock.on("connect", () => sock.write(encodeFrame(request)));
          sock.on("data", (chunk) => {
            buffer = Buffer.concat([buffer, chunk]);
            const decoded = decodeFrames(buffer);
            const first = decoded.messages[0];
            if (first) { sock.destroy(); resolveReply({ ...first, _elapsed: Date.now() - started }); }
          });
          sock.on("error", rejectReply);
          sock.on("end", () => rejectReply(new Error("server closed the socket before replying")));
          setTimeout(() => { sock.destroy(); rejectReply(new Error("no reply within 5s")); }, 5_000);
        });

        // The reply arrived after 900ms, i.e. ~6x the idle ceiling.
        expect(Number(reply._elapsed)).toBeGreaterThan(500);
        expect(reply.reply_to).toBe(request.id);
        expect(reply).toMatchObject({ mode: "chunk" });
      } finally {
        await alpha.stop();
      }
    } finally {
      await beta.stop();
    }
  });

  it("pings, chats, synchronizes, and runs a durable remote job", async () => {
    const [rootA, rootB] = await Promise.all([temporary("alpha"), temporary("beta")]);
    const configA = config(rootA, "alpha");
    const configB = config(rootB, "beta");
    await Promise.all([mkdir(configA.workspace, { recursive: true }), mkdir(configB.workspace, { recursive: true })]);
    await writeFile(join(configA.workspace, "context.txt"), "hello from alpha\n", "utf8");

    const alpha = new MeshRuntime(configA);
    const beta = new MeshRuntime(configB);
    beta.setJobRunner(async (job, _signal, log) => {
      log("info", `received ${job.id}`);
      const context = await readFile(join(job.workspace, "context.txt"), "utf8");
      return { ok: true, text: `${job.instruction}: ${context.trim()}` };
    });
    await Promise.all([alpha.start(), beta.start()]);
    const jobEvents: MeshEvent[] = [];
    const offJobEvents = beta.onEvent((event) => {
      if (event.type === "job" || event.type === "job-log") jobEvents.push(event);
    });
    try {
      await alpha.addContact({ name: "beta", host: "127.0.0.1", port: configB.mesh.port, udpPort: configB.mesh.udpPort, note: "test" });
      await beta.addContact({ name: "alpha", host: "127.0.0.1", port: configA.mesh.port, udpPort: configA.mesh.udpPort, note: "test" });

      await expect(alpha.ping("beta")).resolves.toContain("reachable");
      expect(alpha.peer("beta").online).toBe(true);

      const received = new Promise<string>((resolveMessage) => {
        const off = beta.onEvent((event) => {
          if (event.type === "chat") {
            off();
            resolveMessage(`${event.from}:${event.text}`);
          }
        });
      });
      const sent: MeshEvent[] = [];
      const offSent = alpha.onEvent((event) => { if (event.type === "chat") sent.push(event); });
      const receipt = await alpha.message("beta", "are you ready?");
      offSent();
      expect(receipt).toContain("Delivered to beta");
      expect(receipt).toContain("receipt msg-");
      await expect(received).resolves.toBe("alpha:are you ready?");
      await expect(beta.inbox()).resolves.toMatchObject([{ from: "alpha", to: "beta", text: "are you ready?" }]);
      expect(sent).toMatchObject([{ type: "chat", message: { from: "alpha", to: "beta", text: "are you ready?" } }]);
      await expect(alpha.chats()).resolves.toMatchObject([{ from: "alpha", to: "beta", text: "are you ready?" }]);
      await expect(beta.chats()).resolves.toMatchObject([{ from: "alpha", to: "beta", text: "are you ready?" }]);
      await expect(readFile(join(configA.mesh.jobsDir, "chat-outbox.jsonl"), "utf8")).resolves.toContain('"to":"beta"');

      await expect(alpha.syncPush("beta", "shared-project", configA.workspace, "chunk")).resolves.toContain("changed=1");
      await expect(readFile(join(configB.workspace, "context.txt"), "utf8")).resolves.toBe("hello from alpha\n");
      await writeFile(join(configB.workspace, "remote-only.txt"), "created on beta\n", "utf8");
      await expect(alpha.syncPull("beta", "shared-project", configA.workspace, "chunk")).resolves.toContain("changed=1");
      await expect(readFile(join(configA.workspace, "remote-only.txt"), "utf8")).resolves.toBe("created on beta\n");

      const handoff = await alpha.handoff("beta", "summarize", "shared-project", 30);
      expect(handoff).toContain("done");
      expect(handoff).toContain("summarize: hello from alpha");
      expect(handoff).toContain("received job-");
      const jobs = await beta.jobs();
      expect(jobs[0]?.status).toBe("done");

      const jobIds = new Set(jobs.map((job) => job.id));
      const jobStates = jobEvents.filter((event): event is Extract<MeshEvent, { type: "job" }> =>
        event.type === "job" && jobIds.has(event.job.id));
      expect(jobStates.map((event) => event.job.status)).toContain("queued");
      expect(jobStates.map((event) => event.job.status)).toContain("working");
      expect(jobStates.at(-1)?.job.status).toBe("done");
      expect(jobStates[0]?.job.source).toBe("alpha");
      const jobLogs = jobEvents.filter((event): event is Extract<MeshEvent, { type: "job-log" }> => event.type === "job-log");
      expect(jobLogs.some((event) => event.message.includes("received job-"))).toBe(true);
    } finally {
      offJobEvents();
      await Promise.all([alpha.stop(), beta.stop()]);
    }
  }, 15_000);

  it("polls remote job logs in bounded, duplicate-free batches", async () => {
    const [rootA, rootB] = await Promise.all([temporary("poll-a"), temporary("poll-b")]);
    const configA = config(rootA, "alpha");
    const configB = config(rootB, "beta");
    await Promise.all([mkdir(configA.workspace, { recursive: true }), mkdir(configB.workspace, { recursive: true })]);
    await writeFile(join(configA.workspace, "context.txt"), "poll context\n", "utf8");

    const alpha = new MeshRuntime(configA);
    const beta = new MeshRuntime(configB);
    beta.setJobRunner(async (job, _signal, log) => {
      for (let line = 0; line < 400; line += 1) log("info", `step ${line}`);
      await new Promise((resolveWait) => setTimeout(resolveWait, 300));
      return { ok: true, text: `done ${job.instruction}` };
    });
    await Promise.all([alpha.start(), beta.start()]);
    try {
      await alpha.addContact({ name: "beta", host: "127.0.0.1", port: configB.mesh.port, udpPort: configB.mesh.udpPort, note: "test" });
      await beta.addContact({ name: "alpha", host: "127.0.0.1", port: configA.mesh.port, udpPort: configA.mesh.udpPort, note: "test" });
      await alpha.syncPush("beta", "shared-project", configA.workspace, "chunk");

      const jobId = "job-poll-batch-test";
      await alpha.rpc("beta", "job_submit", { job_id: jobId, project_id: "shared-project", instruction: "log a lot", source: "alpha", lease_seconds: 60 }, 15_000);
      const indices: number[] = [];
      let last: JsonObject | undefined;
      for (let attempt = 0; attempt < 100; attempt += 1) {
        last = await alpha.rpc("beta", "job_poll", { job_id: jobId }, 15_000);
        const tail = Array.isArray(last.log_tail) ? last.log_tail : [];
        expect(tail.length).toBeLessThanOrEqual(300);
        for (const raw of tail) {
          const line = raw as JsonObject;
          indices.push(Number(line.i));
          expect(String(line.msg)).toMatch(/^step \d+$/u);
        }
        if (["done", "failed", "cancelled"].includes(String(last.status))) break;
        await new Promise((resolveWait) => setTimeout(resolveWait, 200));
      }
      expect(String(last?.status)).toBe("done");
      for (let index = 1; index < indices.length; index += 1) expect(indices[index]).toBeGreaterThan(indices[index - 1]);
      expect(indices.length).toBeGreaterThan(0);
    } finally {
      await Promise.all([alpha.stop(), beta.stop()]);
    }
  }, 20_000);

  const pythonSource = resolve(process.cwd(), "../luban");
  (existsSync(join(pythonSource, "luban", "transport.py")) ? it : it.skip)("exchanges live RPC frames with the Python implementation", async () => {
    const root = await temporary("interop");
    const nodeConfig = config(root, "node-peer");
    await mkdir(nodeConfig.workspace, { recursive: true });
    const pythonWorkspace = join(root, "python-workspace");
    await mkdir(pythonWorkspace, { recursive: true });
    const node = new MeshRuntime(nodeConfig);
    await node.start();

    const pythonServer = spawn("python3", ["-u", "-c", [
      "import asyncio, json, sys",
      "from pathlib import Path",
      "import luban.sync as sync",
      "from luban.transport import MeshServer",
      "async def handler(msg, peer):",
      "    payload = msg.get('payload') or {}",
      "    if msg.get('type') == 'ping': return {'ok': True, 'name': 'python-peer', 'pong': 1}",
      "    if msg.get('type') == 'sync_request': return sync.plan_response(Path(sys.argv[1]), payload)",
      "    if msg.get('type') == 'sync_transfer': return {'ok': True, **sync.apply_transfer(Path(sys.argv[1]), payload)}",
      "    if msg.get('type') == 'sync_pull':",
      "        plan = sync.plan_response(Path(sys.argv[1]), payload)",
      "        return {'ok': True, **sync.build_transfer(plan, sys.argv[1], 'auto', 'python-peer')} ",
      "    return {'ok': False, 'error': 'unsupported'}",
      "async def main():",
      "    server = MeshServer('python-peer', '127.0.0.1', 0, handler, {})",
      "    await server.start()",
      "    print(server.port, flush=True)",
      "    await asyncio.Event().wait()",
      "asyncio.run(main())",
    ].join("\n"), pythonWorkspace], {
      env: { ...process.env, PYTHONPATH: pythonSource },
      stdio: ["ignore", "pipe", "pipe"],
    });
    try {
      const pythonPort = await new Promise<number>((resolvePort, reject) => {
        const timeout = setTimeout(() => reject(new Error("Python peer did not start")), 5_000);
        pythonServer.once("error", reject);
        pythonServer.stdout.once("data", (chunk) => {
          clearTimeout(timeout);
          const port = Number(String(chunk).trim().split(/\s/u)[0]);
          if (Number.isInteger(port) && port > 0) resolvePort(port);
          else reject(new Error(`invalid Python peer port: ${String(chunk)}`));
        });
      });
      await node.addContact({ name: "python-peer", host: "127.0.0.1", port: pythonPort, udpPort: 0, note: "interop" });
      await expect(node.ping("python-peer")).resolves.toContain("python-peer");
      await writeFile(join(nodeConfig.workspace, "node-to-python.txt"), "cross-language push\n", "utf8");
      await expect(node.syncPush("python-peer", "shared-project", nodeConfig.workspace, "chunk")).resolves.toContain("changed=1");
      await expect(readFile(join(pythonWorkspace, "node-to-python.txt"), "utf8")).resolves.toBe("cross-language push\n");

      const pythonClient = spawn("python3", ["-c", [
        "import json, sys",
        "from luban.protocol import envelope",
        "from luban.transport import send_sync",
        "reply = send_sync('127.0.0.1', int(sys.argv[1]), envelope('ping', 'python-client', 'node-peer', {}))",
        "print(json.dumps(reply))",
      ].join("\n"), String(nodeConfig.mesh.port)], {
        env: { ...process.env, PYTHONPATH: pythonSource },
        stdio: ["ignore", "pipe", "pipe"],
      });
      let stdout = "";
      let stderr = "";
      pythonClient.stdout.on("data", (chunk) => { stdout += String(chunk); });
      pythonClient.stderr.on("data", (chunk) => { stderr += String(chunk); });
      const [code] = await once(pythonClient, "exit") as [number | null];
      expect(code, stderr).toBe(0);
      expect(JSON.parse(stdout)).toMatchObject({ ok: true, name: "node-peer" });

      await writeFile(join(pythonWorkspace, "python-to-node.txt"), "cross-language reverse push\n", "utf8");
      const pythonSync = spawn("python3", ["-c", [
        "import json, sys",
        "from pathlib import Path",
        "import luban.sync as sync",
        "from luban.protocol import envelope",
        "from luban.transport import send_sync",
        "root, port = Path(sys.argv[1]), int(sys.argv[2])",
        "files = sync.scan_workspace(str(root))",
        "request = {'project_id': 'shared-project', 'mode': 'chunk', 'files': files, 'head': sync.git_head(root)}",
        "plan = send_sync('127.0.0.1', port, envelope('sync_request', 'python-peer', 'node-peer', request))",
        "transfer = sync.build_transfer(plan, str(root), 'auto', 'python-peer')",
        "transfer['project_id'] = 'shared-project'",
        "print(json.dumps(send_sync('127.0.0.1', port, envelope('sync_transfer', 'python-peer', 'node-peer', transfer))))",
      ].join("\n"), pythonWorkspace, String(nodeConfig.mesh.port)], {
        env: { ...process.env, PYTHONPATH: pythonSource },
        stdio: ["ignore", "pipe", "pipe"],
      });
      let syncStdout = "";
      let syncStderr = "";
      pythonSync.stdout.on("data", (chunk) => { syncStdout += String(chunk); });
      pythonSync.stderr.on("data", (chunk) => { syncStderr += String(chunk); });
      const [syncCode] = await once(pythonSync, "exit") as [number | null];
      expect(syncCode, syncStderr).toBe(0);
      expect(JSON.parse(syncStdout)).toMatchObject({ ok: true });
      await expect(readFile(join(nodeConfig.workspace, "python-to-node.txt"), "utf8")).resolves.toBe("cross-language reverse push\n");
    } finally {
      pythonServer.kill("SIGTERM");
      await node.stop();
    }
  }, 15_000);
});

describe("LAN discovery", () => {
  it("broadcasts to each interface's own subnet, not just the default route", async () => {
    const { directedBroadcasts } = await import("./runtime.js");
    const broadcasts = directedBroadcasts({
      lo: [{ address: "127.0.0.1", netmask: "255.0.0.0", family: "IPv4", internal: true, mac: "", cidr: null }],
      eth0: [{ address: "192.168.1.108", netmask: "255.255.255.0", family: "IPv4", internal: false, mac: "", cidr: null }],
      vmnet1: [{ address: "192.168.86.1", netmask: "255.255.255.0", family: "IPv4", internal: false, mac: "", cidr: null }],
      eth1: [{ address: "10.0.0.5", netmask: "255.255.0.0", family: "IPv4", internal: false, mac: "", cidr: null }],
    } as never);
    // Loopback is skipped; a /24 and a /16 both yield the right directed address.
    expect(broadcasts).toContain("192.168.1.255");
    expect(broadcasts).toContain("192.168.86.255");
    expect(broadcasts).toContain("10.0.255.255");
    expect(broadcasts.some((entry) => entry.startsWith("127."))).toBe(false);
  });
});
