#!/usr/bin/env node
import React from "react";
import { access } from "node:fs/promises";
import process from "node:process";
import { Command } from "commander";
import { render } from "ink";
import { AgentRunner, initialMessages } from "./core/agent.js";
import { loadConfig } from "./core/config.js";
import { announceHost, directedBroadcasts, MeshRuntime } from "./core/mesh/runtime.js";
import { configureRemoteJobs } from "./core/mesh/agent-runner.js";
import { SessionStore } from "./core/session-store.js";
import type { AgentEvent, ChatMessage, LubanConfig } from "./core/types.js";
import { App } from "./ui/app.js";
import { LubanWebServer } from "./web/server.js";
import { ApprovalBroker } from "./web/approval.js";
import { AcpServer } from "./core/acp.js";

import { VERSION } from "./version.js";

interface CliOptions {
  resume?: string | boolean;
  model?: string;
  backend?: string;
  yes?: boolean;
  prompt?: string;
  mesh?: boolean;
  meshName?: string;
  meshPort?: number;
  webHost?: string;
  webPort?: number;
  planning?: string;
}

interface DaemonOptions {
  host: string;
  port: number;
  model?: string;
  yes?: boolean;
  mesh?: boolean;
  meshName?: string;
  meshPort?: number;
}

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks).toString("utf8").trim();
}

function headlessEvent(event: AgentEvent): void {
  if (event.type === "tool-start") process.stderr.write(`◇ ${event.name}\n`);
  if (event.type === "tool-end") process.stderr.write(`${event.ok ? "✓" : "✗"} ${event.name} ${(event.elapsedMs / 1000).toFixed(2)}s\n`);
  if (event.type === "error") process.stderr.write(`error: ${event.text}\n`);
}

function oneLine(value: string, limit = 200): string {
  const flat = value.trim().replaceAll(/\s+/gu, " ");
  return flat.length > limit ? `${flat.slice(0, limit - 1)}…` : flat;
}

async function runHeadless(config: LubanConfig, prompt: string, mesh?: MeshRuntime): Promise<number> {
  process.stderr.write(`luban v${VERSION}\n`);
  const store = new SessionStore(config.home);
  const messages: ChatMessage[] = [...initialMessages(config.workspace, config.model.name, config.planning), { role: "user", content: prompt }];
  const session = store.create(config.project, config.workspace, "agent", config.model.id, messages);
  const runner = new AgentRunner(config, undefined, mesh);
  const controller = new AbortController();
  const interrupt = () => controller.abort(new Error("interrupted"));
  process.once("SIGINT", interrupt);
  try {
    const result = await runner.run(
      messages,
      "agent",
      controller.signal,
      headlessEvent,
      async () => config.permissionMode === "allow" ? "always" : "deny",
      () => store.save(session),
    );
    session.messages = result.messages;
    await store.save(session);
    process.stdout.write(`${result.text.trim()}\n`);
    // Same accounting the TUI shows, so headless runs are measurable too.
    process.stderr.write(`[${result.steps} steps · ${result.modelCalls} model calls · ${(result.elapsedMs / 1000).toFixed(1)}s · ${(result.elapsedMs / Math.max(1, result.modelCalls) / 1000).toFixed(1)}s/call]\n`);
    return result.ok ? 0 : 1;
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    return 1;
  } finally {
    runner.close();
    process.removeListener("SIGINT", interrupt);
  }
}

async function workspaceExists(workspace: string): Promise<boolean> {
  try { await access(workspace); return true; } catch { return false; }
}

function daemonConfig(workspace: string, options: Pick<DaemonOptions, "model" | "yes" | "mesh" | "meshName" | "meshPort">): LubanConfig {
  return loadConfig({
    workspace,
    model: options.model,
    allow: options.yes,
    mesh: options.mesh,
    meshName: options.meshName,
    meshPort: options.meshPort,
  });
}

async function waitForShutdown(): Promise<void> {
  await new Promise<void>((resolveShutdown) => {
    const done = () => {
      process.removeListener("SIGINT", done);
      process.removeListener("SIGTERM", done);
      resolveShutdown();
    };
    process.once("SIGINT", done);
    process.once("SIGTERM", done);
  });
}

async function runDaemon(argv: string[], webMode: boolean): Promise<number> {
  const program = new Command();
  program
    .name(webMode ? "luban web" : "luban serve")
    .description(webMode ? "Run the native Node mesh and browser workspace" : "Run the native Node mesh daemon")
    .version(VERSION)
    .argument("[path]", "workspace directory", process.cwd())
    .option("-m, --model <provider/model>", "override the active model")
    .option("--host <host>", "HTTP bind host", "127.0.0.1")
    .option("--port <port>", "HTTP port (0 chooses a free port)", (value) => Number(value), 8642)
    .option("--no-mesh", "disable LAN TCP/UDP while keeping local Web jobs")
    .option("--mesh-name <name>", "override this mesh node name")
    .option("--mesh-port <port>", "override the mesh TCP port", (value) => Number(value))
    .option("-y, --yes", "accepted for parity; daemon jobs are explicitly trusted")
    .showHelpAfterError();
  program.parse(argv, { from: "user" });
  const workspace = (program.args[0] ?? process.cwd()) as string;
  const options = program.opts<DaemonOptions>();
  if (!await workspaceExists(workspace)) {
    process.stderr.write(`workspace does not exist: ${workspace}\n`);
    return 2;
  }
  process.stderr.write(`luban v${VERSION}\n`);
  const config = daemonConfig(workspace, options);
  const mesh = new MeshRuntime(config);
  // One broker serves both callers: the HTTP layer answers prompts for
  // browser-driven jobs, while daemon jobs keep their always-allow default.
  const approvals = new ApprovalBroker();
  configureRemoteJobs(mesh, config, undefined, {
    approve: (tool, args, jobId) => approvals.request(jobId, tool, args),
    isInteractive: jobId => Boolean(web?.isInteractiveJob(jobId)),
    modeFor: jobId => web?.jobMode(jobId) ?? "edits",
  });
  let web: LubanWebServer | undefined;
  try {
    await mesh.start();
    const announcedJobs = new Set<string>();
    const openText = new Map<string, "delta" | "thinking">();
    const closeText = (id: string): void => {
      if (openText.has(id)) process.stdout.write("\n");
      openText.delete(id);
    };
    mesh.onEvent((event) => {
      if (event.type === "chat") {
        const outbound = event.from === config.mesh.nodeName;
        process.stdout.write(`\n${outbound ? "📤 mesh message to" : "📨 mesh message from"} ${outbound ? event.message.to : event.from}: ${event.text}\n`);
      }
      if (event.type === "job-log") {
        if (event.level !== "tool") process.stdout.write(`   [${event.level}] ${oneLine(event.message, 160)}\n`);
        return;
      }
      if (event.type === "job-event") {
        const step = event.event;
        if (step.kind === "delta" || step.kind === "thinking") {
          if (openText.get(event.id) !== step.kind) {
            closeText(event.id);
            process.stdout.write(`   ${step.kind === "thinking" ? "💭" : "↳"} `);
            openText.set(event.id, step.kind);
          }
          process.stdout.write(step.text);
          return;
        }
        closeText(event.id);
        if (step.kind === "model-call") process.stdout.write(`   ◇ model call ${step.index}\n`);
        if (step.kind === "status") process.stdout.write(`   · ${step.text}\n`);
        if (step.kind === "tool-start") process.stdout.write(`   ◇ ${step.name}: ${step.summary || JSON.stringify(step.args)}\n`);
        if (step.kind === "tool-end") {
          process.stdout.write(`   ${step.ok ? "✓" : "✗"} ${step.name} ${(step.elapsedMs / 1000).toFixed(2)}s\n`);
          if (step.preview) process.stdout.write(`${step.preview}\n`);
          if (step.editPreview && step.editPreview !== step.preview) process.stdout.write(`${step.editPreview}\n`);
        }
        if (step.kind === "error") process.stdout.write(`   ✗ ${step.text}\n`);
        return;
      }
      if (event.type !== "job") return;
      const job = event.job;
      closeText(job.id);
      const local = job.source === config.mesh.nodeName;
      if (!announcedJobs.has(job.id)) {
        announcedJobs.add(job.id);
        process.stdout.write(`\n📥 mesh task ${job.id} ${local ? "(local)" : `from ${job.source}`}: ${oneLine(job.instruction)}\n`);
      }
      if (job.status === "done") {
        process.stdout.write(`✅ mesh task ${job.id} ${local ? "(local)" : `from ${job.source}`} done: ${oneLine(job.result) || "(no output)"}\n`);
        announcedJobs.delete(job.id);
      } else if (job.status === "failed") {
        process.stdout.write(`✗ mesh task ${job.id} ${local ? "(local)" : `from ${job.source}`} failed: ${oneLine(job.error)}\n`);
        announcedJobs.delete(job.id);
      } else if (job.status === "cancelled") {
        process.stdout.write(`⊘ mesh task ${job.id} ${local ? "(local)" : `from ${job.source}`} cancelled\n`);
        announcedJobs.delete(job.id);
      }
    });
    if (webMode) {
      web = new LubanWebServer(config, mesh, { host: options.host, port: options.port, approvals });
      const url = await web.start();
      process.stdout.write(`luban web ${url}\n`);
      process.stdout.write(`workspace ${config.workspace}\nmesh ${config.mesh.enabled ? `${config.mesh.nodeName}:${config.mesh.port}` : "disabled"}\n`);
      if (!["127.0.0.1", "localhost", "::1"].includes(options.host)) {
        process.stderr.write("warning: Web API is exposed beyond localhost and can execute agent tools\n");
      }
    } else {
      process.stdout.write(`luban ${config.mesh.nodeName} serving mesh TCP ${config.mesh.host}:${config.mesh.port} UDP ${config.mesh.udpPort}\n`);
    }
    await waitForShutdown();
    return 0;
  } catch (error) {
    process.stderr.write(`${webMode ? "web" : "serve"} startup failed: ${error instanceof Error ? error.message : String(error)}\n`);
    return 2;
  } finally {
    await web?.stop();
    await mesh.stop();
  }
}


/**
 * `luban mesh` — show what this node advertises and whether each contact
 * answers. LAN problems are usually either a route/firewall issue or something
 * else answering on the port, and this separates the two without starting a
 * node or touching the running one.
 */
async function runMeshCheck(argv: string[]): Promise<number> {
  const program = new Command();
  program
    .name("luban mesh")
    .description("Show LAN mesh addressing and probe every contact")
    .version(VERSION)
    .argument("[path]", "workspace directory", process.cwd())
    .option("-m, --model <provider/model>", "override the active model")
    .option("--timeout <seconds>", "per-contact probe timeout", (value) => Number(value), 5)
    .showHelpAfterError();
  program.parse(argv, { from: "user" });
  const workspace = (program.args[0] ?? process.cwd()) as string;
  const options = program.opts<{ model?: string; timeout?: number }>();
  if (!await workspaceExists(workspace)) {
    process.stderr.write(`workspace does not exist: ${workspace}\n`);
    return 2;
  }
  const config = loadConfig({ workspace, model: options.model });
  const mesh = new MeshRuntime(config);
  const write = (line: string) => process.stdout.write(`${line}\n`);

  write(`node        ${config.mesh.nodeName}`);
  write(`bind        tcp ${config.mesh.host}:${config.mesh.port}  udp ${config.mesh.host}:${config.mesh.udpPort}`);
  write(`advertised  ${announceHost(config.mesh.host)}:${config.mesh.port}   <- this is what peers connect to`);
  write(`broadcasts  ${["255.255.255.255", ...directedBroadcasts()].join(", ")}`);
  write(`token       ${config.mesh.token ? "set (both sides must match)" : "not set"}`);

  const contacts = config.mesh.contacts;
  if (!contacts.length) {
    write("");
    write("no contacts configured: discovery relies on UDP broadcast, which only reaches the same subnet.");
    write("add one with  /add-contact <name> <host> <port>  in the TUI, or under \"contacts\" in ~/.luban/config.json.");
    return 0;
  }

  const timeout = Math.max(1, Math.min(120, options.timeout ?? 5)) * 1000;
  write("");
  let failures = 0;
  for (const contact of contacts) {
    write(`${contact.name}  ${contact.host}:${contact.port}`);
    try {
      const reply = await mesh.rpc(contact.name, "ping", {}, timeout);
      write(`  ok      ${JSON.stringify(reply.payload ?? {}).slice(0, 120)}`);
    } catch (error) {
      failures += 1;
      write(`  FAILED  ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  write("");
  write(failures
    ? `${failures}/${contacts.length} contact(s) unreachable. A "connected but no reply" message means something accepted the connection but is not a luban node — check for a proxy/VPN intercepting that address; "could not be reached" means routing, firewall, or the peer is not running.`
    : `all ${contacts.length} contact(s) answered.`);
  return failures ? 1 : 0;
}

async function main(): Promise<number> {
  const program = new Command();
  program
    .name("luban")
    .description("Node.js coding agent with a Grok-style terminal and native LAN mesh")
    .version(VERSION)
    .argument("[path]", "workspace directory", process.cwd())
    .option("-r, --resume [session]", "resume latest or a session id")
    .option("-m, --model <provider/model>", "override the active model")
    .option("--backend <url>", "bridge to a running Python luban web node")
    .option("--no-mesh", "disable the native LAN collaboration node")
    .option("--mesh-name <name>", "override this mesh node name")
    .option("--mesh-port <port>", "override the mesh TCP port (0 chooses a free port)", (value) => Number(value))
    .option("--web-host <host>", "also run the native Web backend on this host", "127.0.0.1")
    .option("--web-port <port>", "also run the native Web backend (0 chooses a free port)", (value) => Number(value))
    .option("-y, --yes", "allow write, execute, and network tools without prompts")
    .option("-p, --prompt <text>", "run once without the TUI")
    .addHelpText("after", "\nCommands:\n  luban web [path]    native Web API + browser workspace\n  luban serve [path]  native mesh/worker daemon\n  luban acp [path]    Agent Client Protocol over stdio (editor integration)\n")
    .showHelpAfterError();
  program.parse();
  const workspace = (program.args[0] ?? process.cwd()) as string;
  const options = program.opts<CliOptions>();
  if (!await workspaceExists(workspace)) {
    process.stderr.write(`workspace does not exist: ${workspace}\n`);
    return 2;
  }
  const config = loadConfig({
    workspace,
    model: options.model,
    backendUrl: options.backend,
    allow: options.yes,
    mesh: options.mesh,
    meshName: options.meshName,
    meshPort: options.meshPort,
  });
  const piped = !process.stdin.isTTY && !options.prompt ? await readStdin() : "";
  const prompt = options.prompt || piped;
  let mesh: MeshRuntime | undefined;
  let web: LubanWebServer | undefined;
  // The TUI keeps its own broker: approvals requested by a browser tab are
  // answered there, while in-terminal jobs keep prompting in the TUI itself.
  const approvals = new ApprovalBroker();
  try {
    if (config.mesh.enabled || options.webPort !== undefined) {
      const candidate = new MeshRuntime(config);
      configureRemoteJobs(candidate, config, undefined, {
        approve: (tool, args, jobId) => approvals.request(jobId, tool, args),
        isInteractive: jobId => Boolean(web?.isInteractiveJob(jobId)),
        modeFor: jobId => web?.jobMode(jobId) ?? "edits",
      });
      try {
        const requestedName = config.mesh.nodeName;
        await candidate.start({ allowPortFallback: options.meshPort === undefined });
        if (candidate.config.mesh.nodeName !== requestedName) {
          process.stderr.write(`mesh instance: ${candidate.config.mesh.nodeName} on port ${candidate.config.mesh.port}\n`);
        }
        mesh = candidate;
      } catch (error) {
        process.stderr.write(`warning: mesh unavailable (${error instanceof Error ? error.message : String(error)}); continuing without LAN collaboration\n`);
        process.stderr.write("Free the mesh ports in ~/.luban/config.json, or start with --no-mesh to skip the warning.\n");
      }
    }
    if (options.webPort !== undefined) {
      if (mesh) {
        web = new LubanWebServer(config, mesh, { host: options.webHost, port: options.webPort, approvals });
        const url = await web.start();
        process.stderr.write(`web workspace: ${url}\n`);
      } else {
        process.stderr.write("warning: skipping web workspace because mesh is unavailable\n");
      }
    }
    if (prompt) return await runHeadless(config, prompt, mesh);
    if (!process.stdin.isTTY || !process.stdout.isTTY) {
      process.stderr.write("interactive mode requires a TTY; use --prompt for one-shot mode\n");
      return 2;
    }
    const resume = typeof options.resume === "string" ? options.resume : options.resume ? "latest" : undefined;
    const instance = render(<App config={config} mesh={mesh} resume={resume} />);
    await instance.waitUntilExit();
    return 0;
  } catch (error) {
    process.stderr.write(`startup failed: ${error instanceof Error ? error.message : String(error)}\n`);
    process.stderr.write("Use --no-mesh to run without LAN collaboration, or choose different ports.\n");
    return 2;
  } finally {
    await web?.stop();
    await mesh?.stop();
  }
}

async function runAcp(argv: string[]): Promise<number> {
  const program = new Command();
  program
    .name("luban acp")
    .description("Serve the Agent Client Protocol over stdio for editor integration")
    .version(VERSION)
    .argument("[path]", "workspace directory", process.cwd())
    .option("-m, --model <provider/model>", "override the active model")
    .option("-y, --yes", "allow write, execute, and network tools without prompts")
    .option("--planning <mode>", "off | auto | always - how much planning the prompt asks for (default: auto)")
    .option("--no-mesh", "disable the native LAN collaboration node")
    .showHelpAfterError();
  program.parse(argv, { from: "user" });
  const workspace = (program.args[0] ?? process.cwd()) as string;
  const options = program.opts<CliOptions>();
  if (!await workspaceExists(workspace)) {
    process.stderr.write(`workspace does not exist: ${workspace}\n`);
    return 2;
  }
  const config = loadConfig({ workspace, model: options.model, allow: options.yes, mesh: false });
  const runners = new Map<string, { runner: AgentRunner; messages: ChatMessage[] }>();
  const server = new AcpServer(workspace, async (sessionId, sessionWorkspace, text, onChunk, signal) => {
    let state = runners.get(sessionId);
    if (!state) {
      const runner = new AgentRunner({ ...config, workspace: sessionWorkspace });
      state = { runner, messages: initialMessages(sessionWorkspace, config.model.name) };
      runners.set(sessionId, state);
    }
    state.messages.push({ role: "user", content: text });
    const result = await state.runner.run(state.messages, "agent", signal,
      (event) => { if (event.type === "delta") onChunk(event.text); },
      async () => config.permissionMode === "allow" ? "always" : "deny");
    state.messages = result.messages;
    if (!result.text.trim()) return "(no output)";
    return result.text;
  }, (line) => process.stdout.write(line));
  process.stderr.write(`luban acp workspace=${workspace} model=${config.model.id}\n`);
  let buffer = "";
  process.stdin.setEncoding("utf8");
  for await (const chunk of process.stdin) {
    buffer += chunk;
    let newline = buffer.indexOf("\n");
    while (newline >= 0) {
      const line = buffer.slice(0, newline).trim();
      buffer = buffer.slice(newline + 1);
      if (line) await server.handleLine(line);
      newline = buffer.indexOf("\n");
    }
  }
  for (const state of runners.values()) state.runner.close();
  return 0;
}

const command = process.argv[2];
const entry = command === "web"
  ? runDaemon(process.argv.slice(3), true)
  : command === "serve"
    ? runDaemon(process.argv.slice(3), false)
    : command === "acp"
      ? runAcp(process.argv.slice(3))
      : command === "mesh"
        ? runMeshCheck(process.argv.slice(3))
        : main();

entry.then((code) => { process.exitCode = code; }).catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.stack || error.message : String(error)}\n`);
  process.exitCode = 1;
});
