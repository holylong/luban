#!/usr/bin/env node
import "./runtime-env.js";
import React from "react";
import { spawn } from "node:child_process";
import { access, readFile } from "node:fs/promises";
import { createInterface as createCallbackInterface } from "node:readline";
import { createInterface } from "node:readline/promises";
import { existsSync, readFileSync } from "node:fs";
import process from "node:process";
import { Command } from "commander";
import { render } from "ink";
import { AgentRunner, initialMessages } from "./core/agent.js";
import { loadConfig, savePreferredModel } from "./core/config.js";
import { codexInvocation } from "./core/codex-command.js";
import { announceHost, directedBroadcasts, MeshRuntime } from "./core/mesh/runtime.js";
import { configureRemoteJobs } from "./core/mesh/agent-runner.js";
import { SessionStore } from "./core/session-store.js";
import { sharedHistory } from "./core/session-history.js";
import { runHistory } from "./core/history-command.js";
import { runMcp } from "./core/mcp-command.js";
import { runBot } from "./core/bot-command.js";
import { runReport } from "./core/report-command.js";
import type { AgentEvent, ChatMessage, LubanConfig, ToolDefinition } from "./core/types.js";
import { App } from "./ui/app.js";
import { terminalOutput } from "./ui/terminal-output.js";
import { mascotOutput } from "./ui/mascot-background.js";
import { applyTheme, resolveThemeId, themeIds } from "./ui/theme.js";
import { LubanWebServer } from "./web/server.js";
import { ApprovalBroker } from "./web/approval.js";
import { QuestionBroker } from "./web/question.js";
import { AcpServer } from "./core/acp.js";
import { LubanRelayServer } from "./web/relay.js";
import { TunnelClient, normalizeRelayUrl } from "./web/tunnel.js";
import { generateToken } from "./web/auth.js";
import { defaultAccountsPath } from "./web/accounts.js";
import { instanceDeviceId } from "./web/device-id.js";
import { readDeviceStatus } from "./web/device-status.js";
import { loginRelayAccount, saveRelayDeviceToken } from "./web/relay-login.js";
import { installProcessGuard } from "./core/process-guard.js";
import { generateTlsMaterial, readTlsMaterial } from "./web/tls.js";
import { sendVerificationEmail, smtpFromEnv } from "./web/mailer.js";
import { homedir, networkInterfaces, tmpdir } from "node:os";
import { basename, join } from "node:path";

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
  theme?: string;
  token?: string;
}

interface DaemonOptions {
  host: string;
  port: number;
  model?: string;
  yes?: boolean;
  mesh?: boolean;
  meshName?: string;
  meshPort?: number;
  token?: string;
  relay?: string;
  relayToken?: string;
  relayCa?: string;
  relayDeviceToken?: string;
}

const LOOPBACK = new Set(["127.0.0.1", "localhost", "::1", "[::1]"]);

/**
 * Addresses a phone on the same network will dial, for the LAN certificate's
 * SANs: the loopback plus every non-internal IPv4 the machine advertises. When
 * the relay binds a specific host, that host is included too.
 */
function lanAddresses(bindHost: string): string[] {
  const hosts = new Set<string>(["127.0.0.1", "localhost"]);
  if (!LOOPBACK.has(bindHost) && !["0.0.0.0", "::"].includes(bindHost)) hosts.add(bindHost);
  for (const info of Object.values(networkInterfaces())) {
    for (const entry of info || []) {
      if (entry.family === "IPv4" && !entry.internal) hosts.add(entry.address);
    }
  }
  return [...hosts];
}

/** Phone-visible label: host name plus the project folder that instance serves. */
function relayNodeName(nodeName: string, workspace: string): string {
  const folder = basename(workspace);
  return folder && folder !== nodeName ? `${nodeName} · ${folder}` : nodeName;
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

function readEnvFileValue(path: string, key: string): string {
  if (!existsSync(path)) return "";
  const prefix = new RegExp(`^\\s*(?:export\\s+)?${key}\\s*=(.*)$`, "u");
  for (const line of readFileSync(path, "utf8").split(/\r?\n/u)) {
    const match = line.match(prefix);
    if (!match) continue;
    return match[1]!.trim().replace(/^(['"])(.*)\1$/u, "$2");
  }
  return "";
}

/**
 * A session store for one loaded config: the JSON records plus, when the
 * `history` block enables it, the queryable SQLite mirror that shares them.
 * Every entry point builds its store here so the TUI, one-shot runs, the Web
 * API and remote jobs all mirror the same way.
 *
 * @param config Loaded configuration carrying the home directory and `history`.
 * @returns Store used for every session save in this process.
 */
function sessionStore(config: LubanConfig): SessionStore {
  return new SessionStore(config.home, sharedHistory(config.history, config.home));
}

async function runHeadless(config: LubanConfig, prompt: string, mesh?: MeshRuntime): Promise<number> {
  process.stderr.write(`luban v${VERSION}\n`);
  const store = sessionStore(config);
  const messages: ChatMessage[] = [...initialMessages(config.workspace, config.model.name, config.planning, config.kev?.mode, config.sandbox?.allowOutsideWorkspace === true), { role: "user", content: prompt }];
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
    session.performance = result.metrics;
    await store.save(session);
    process.stdout.write(`${result.text.trim()}\n`);
    // Same accounting the TUI shows, so headless runs are measurable too.
    process.stderr.write(`[${result.steps} steps · ${result.modelCalls} model calls · ${(result.elapsedMs / 1000).toFixed(1)}s · ${(result.elapsedMs / Math.max(1, result.modelCalls) / 1000).toFixed(1)}s/call]\n`);
    if (result.metrics) {
      const timing = result.metrics;
      process.stderr.write(`[model ${(timing.modelMs / 1000).toFixed(1)}s · tools cumulative ${(timing.toolMs / 1000).toFixed(1)}s · approval ${(timing.approvalMs / 1000).toFixed(1)}s · ${timing.compactions} compactions]\n`);
    }
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
    seedDefaults: true,
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
    .option("--token <token>", "browser access token (or LUBAN_WEB_TOKEN; generated for non-loopback binds)")
    .option("--relay <url>", "dial out to a luban relay so a phone on the internet can reach this workspace")
    .option("--relay-token <token>", "relay node token (or LUBAN_RELAY_NODE_TOKEN)")
    .option("--relay-device-token <token>", "account device-enrollment token (or LUBAN_RELAY_DEVICE_TOKEN)")
    .option("--relay-ca <path>", "PEM CA to trust when the relay URL is https with a self-signed certificate")
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
  const questions = new QuestionBroker();
  configureRemoteJobs(mesh, config, undefined, {
    approve: (tool, args, jobId) => approvals.request(jobId, tool, args),
    askUser: (jobId, question, signal) => questions.request(jobId, question, signal),
    isInteractive: jobId => Boolean(web?.isInteractiveJob(jobId)),
    modeFor: jobId => web?.jobMode(jobId) ?? "edits",
  });
  let web: LubanWebServer | undefined;
  let tunnel: TunnelClient | undefined;
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
      // Reaching the Web API from another machine means reaching an agent that
      // runs shell commands, so a non-loopback bind without a token would make
      // the workspace world-writable. One is generated instead of refused, and
      // printed with the link that carries it.
      const exposed = !LOOPBACK.has(options.host);
      const token = options.token?.trim() || process.env.LUBAN_WEB_TOKEN?.trim() || (exposed ? generateToken() : undefined);
      web = new LubanWebServer(config, mesh, { host: options.host, port: options.port, approvals, questions, token });
      const url = await web.start();
      process.stdout.write(`luban web ${url}\n`);
      process.stdout.write(`workspace ${config.workspace}\nmesh ${config.mesh.enabled ? `${config.mesh.nodeName}:${config.mesh.port}` : "disabled"}\n`);
      if (web.requiresToken) {
        process.stdout.write(`手机/浏览器控制台 ${url}m/?token=${encodeURIComponent(token!)}\n`);
      }
      if (options.relay) {
        const relayUrl = normalizeRelayUrl(options.relay);
        const relayToken = options.relayToken?.trim() || process.env.LUBAN_RELAY_NODE_TOKEN?.trim();
        const relayDeviceToken = options.relayDeviceToken?.trim() || process.env.LUBAN_RELAY_DEVICE_TOKEN?.trim();
        if (!relayToken && !relayDeviceToken) {
          process.stderr.write("--relay requires --relay-token or --relay-device-token: the relay prints its node token, or generate a device token in the phone settings\n");
          return 2;
        }
        // Node's TLS `ca` option wants the PEM body, not a path: read the file
        // the operator pointed at, and fail loudly if it is not there rather
        // than fall back to the system store and reject the self-signed relay.
        let relayCa: string | undefined;
        if (options.relayCa) {
          if (!existsSync(options.relayCa)) {
            process.stderr.write(`--relay-ca file does not exist: ${options.relayCa}\n`);
            return 2;
          }
          relayCa = readFileSync(options.relayCa, "utf8");
        }
        // The tunnel proxies to the loopback port the server actually bound,
        // which may differ from --port when 0 was requested.
        tunnel = new TunnelClient({
          relayUrl,
          nodeToken: relayToken || "",
          ...(relayDeviceToken ? { deviceToken: relayDeviceToken } : {}),
          deviceId: instanceDeviceId(config.home, config.workspace),
          status: () => readDeviceStatus(config, mesh),
          localPort: web.port,
          localHost: "127.0.0.1",
          localToken: token,
          name: relayNodeName(config.mesh.nodeName, config.workspace),
          version: VERSION,
          workspace: config.workspace,
          projects: mesh.projectMap(),
          relayCa,
          log: (message) => process.stderr.write(`relay: ${message}\n`),
        });
        await tunnel.start();
      }
      if (exposed) {
        process.stderr.write("warning: Web API is exposed beyond localhost; every request needs the access token\n");
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
    tunnel?.stop();
    await web?.stop();
    await mesh.stop();
  }
}

/**
 * `luban relay` — the public half of the phone link.
 *
 * Runs on a host with a public address. Nodes dial out to it, so the laptop
 * behind NAT needs no inbound port and no firewall change; the phone talks to
 * the relay, which forwards into the tunnel. The relay holds no job state: if it
 * is restarted the laptops keep working and reconnect.
 */
async function runRelay(argv: string[]): Promise<number> {
  const program = new Command();
  program
    .name("luban relay")
    .description("Run the public relay that lets phones drive luban nodes over a dial-out tunnel")
    .version(VERSION)
    .option("--host <host>", "bind address", "0.0.0.0")
    .option("--port <port>", "bind port", (value) => Number(value), 8788)
    .option("--token <token>", "phone access token (or LUBAN_RELAY_ACCESS_TOKEN; generated when omitted)")
    .option("--node-token <token>", "node registration token (or LUBAN_RELAY_NODE_TOKEN; generated when omitted)")
    .option("--accounts <path>", "account database (defaults to <LUBAN_HOME>/relay-accounts.json; use 'none' to disable accounts)")
    .option("--public-url <url>", "public base URL, when it differs from host:port")
    .option("--https", "serve HTTPS for secure phone access and browser PWA installation")
    .option("--tls-key <path>", "PEM private key for --https (a LAN certificate is generated when omitted)")
    .option("--tls-cert <path>", "PEM certificate for --https, paired with --tls-key")
    .option("--tls-dir <path>", "directory to persist a generated LAN certificate so the phone trusts it once")
    .option("--smtp-email <address>", "mailbox used to send registration codes (or LUBAN_RELAY_SMTP_EMAIL)")
    .option("--smtp-password <password>", "SMTP app password (or LUBAN_RELAY_SMTP_PASSWORD; prefer the env file)")
    .option("--smtp-host <host>", "SMTP host (default smtp.163.com)")
    .option("--smtp-port <port>", "SMTP TLS port (default 465)", (value) => Number(value))
    .showHelpAfterError();
  program.parse(argv, { from: "user" });
  const options = program.opts<{ host: string; port: number; token?: string; nodeToken?: string; accounts?: string; publicUrl?: string; https?: boolean; tlsKey?: string; tlsCert?: string; tlsDir?: string; smtpEmail?: string; smtpPassword?: string; smtpHost?: string; smtpPort?: number }>();
  process.stderr.write(`luban v${VERSION}\n`);
  let tls: { key: string; cert: string; ca: string } | undefined;
  let caPath: string | undefined;
  if (options.https || options.tlsKey || options.tlsCert) {
    if (options.tlsKey && options.tlsCert) {
      tls = readTlsMaterial(options.tlsKey, options.tlsCert);
      caPath = options.tlsCert;
    } else {
      const material = generateTlsMaterial({ hosts: lanAddresses(options.host), dir: options.tlsDir });
      tls = material;
      caPath = `${options.tlsDir || join(tmpdir(), "luban-relay-tls")}/ca.pem`;
    }
  }
  const accountsPath = options.accounts === "none"
    ? undefined
    : options.accounts?.trim() || defaultAccountsPath(process.env.LUBAN_HOME?.trim() || join(homedir(), ".luban"));
  const smtpEnv = smtpFromEnv();
  const smtp = options.smtpEmail || options.smtpPassword
    ? {
      host: options.smtpHost?.trim() || smtpEnv?.host || "smtp.163.com",
      port: options.smtpPort || smtpEnv?.port || 465,
      from: options.smtpEmail?.trim() || smtpEnv?.from || "",
      password: options.smtpPassword || smtpEnv?.password || "",
    }
    : smtpEnv;
  const email = smtp?.from && smtp.password
    ? { sendVerificationCode: (to: string, code: string) => sendVerificationEmail(smtp, to, code) }
    : undefined;
  const relay = new LubanRelayServer({
    host: options.host,
    port: options.port,
    token: options.token?.trim() || process.env.LUBAN_RELAY_ACCESS_TOKEN?.trim(),
    nodeToken: options.nodeToken?.trim() || process.env.LUBAN_RELAY_NODE_TOKEN?.trim(),
    ...(accountsPath ? { accountsPath } : {}),
    ...(email ? { email } : {}),
    publicUrl: options.publicUrl,
    tls,
    log: (message) => process.stderr.write(`relay: ${message}\n`),
  });
  try {
    const url = await relay.start();
    if (LOOPBACK.has(options.host)) {
      process.stderr.write("warning: the relay is bound to loopback; a phone on another network cannot reach it\n");
    }
    process.stdout.write(`luban relay ${url}\n`);
    if (accountsPath) {
      process.stdout.write(`账号登录 ${relay.publicBaseUrl()}/m/  （注册或登录后查看账户下的所有电脑）\n`);
      process.stdout.write(`账户库 ${accountsPath}\n`);
      process.stdout.write(smtp?.from
        ? `注册验证码 邮件由 ${smtp.from} 发送\n`
        : "注册验证码 未配置邮箱（设置 LUBAN_RELAY_SMTP_EMAIL / LUBAN_RELAY_SMTP_PASSWORD）\n");
    } else {
      process.stdout.write(`手机访问 ${relay.mobileLink()}\n`);
    }
    if (tls && caPath) {
      process.stdout.write(options.tlsKey && options.tlsCert
        ? "HTTPS：确保证书对手机访问的域名有效且受设备信任。\n"
        : `HTTPS：自签证书需受手机信任。把 ${caPath} 安装为手机 CA；电脑节点连接时使用 --relay-ca ${caPath}。\n`);
    }
    process.stdout.write(`节点连接 luban web <项目路径> --relay ${relay.publicBaseUrl()} --relay-token ${relay.nodeToken}${accountsPath ? " --relay-device-token <在手机“添加电脑”中生成的设备令牌>" : ""}${tls ? " --relay-ca " + caPath : ""}\n`);
    await waitForShutdown();
    return 0;
  } catch (error) {
    process.stderr.write(`relay startup failed: ${error instanceof Error ? error.message : String(error)}\n`);
    return 2;
  } finally {
    await relay.stop();
  }
}

/** Read a JSON object, treating a missing file as an empty object. */
async function readJsonObject(path: string): Promise<Record<string, unknown>> {
  try {
    const parsed = JSON.parse(await readFile(path, "utf8")) as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as Record<string, unknown> : {};
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return {};
    throw error;
  }
}

async function promptLine(label: string): Promise<string> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    return (await rl.question(label)).trim();
  } finally {
    rl.close();
  }
}

/** Ask for a password without echoing it; the terminal still needs to be a TTY. */
async function promptHidden(label: string): Promise<string> {
  const input = process.stdin;
  const wasRaw = Boolean(input.isTTY && input.isRaw);
  // Readline echoes typed characters even when its own writer is muted, so turn
  // off terminal echo for the duration of the prompt.
  if (input.isTTY) input.setRawMode(true);
  // The promises wrapper hides the underlying interface, whose writer must be
  // muted; use the callback interface here so the override takes effect.
  const rl = createCallbackInterface({ input, output: process.stdout, terminal: true });
  const writer = rl as unknown as { _writeToOutput?: (text: string) => void };
  const original = writer._writeToOutput;
  writer._writeToOutput = () => {};
  process.stdout.write(label);
  try {
    return await new Promise<string>((resolve) => {
      let settled = false;
      const finish = (value: string) => {
        if (settled) return;
        settled = true;
        resolve(value);
      };
      rl.once("SIGINT", () => finish(""));
      rl.once("close", () => finish(""));
      rl.question("", answer => finish(answer));
    });
  } finally {
    if (original) writer._writeToOutput = original;
    rl.close();
    if (input.isTTY && !wasRaw) input.setRawMode(false);
    process.stdout.write("\n");
  }
}

async function readStdinText(): Promise<string> {
  let text = "";
  for await (const chunk of process.stdin) text += String(chunk);
  return text.trim();
}

/**
 * `luban login relay` — sign in with an account without opening the phone UI,
 * then save the device token where `luban` and `luban web` already look for it.
 * Passwords only come from a hidden prompt or stdin and are never written down.
 */
async function runRelayLogin(argv: string[]): Promise<number> {
  const program = new Command();
  program
    .name("luban login relay")
    .description("Sign in to a relay account and enroll this computer without a browser")
    .version(VERSION)
    .option("--relay <url>", "relay URL (defaults to remote.relay_url in ~/.luban/config.json)")
    .option("--email <email>", "account email; prompted when omitted")
    .option("--password-stdin", "read the password from stdin instead of prompting")
    .option("--device-token <token>", "save an existing device token instead of signing in")
    .option("--no-config", "only save the token; do not change ~/.luban/config.json")
    .showHelpAfterError();
  program.parse(argv, { from: "user" });
  const options = program.opts<{
    relay?: string; email?: string; passwordStdin?: boolean; deviceToken?: string; config: boolean;
  }>();

  try {
    const home = process.env.LUBAN_HOME?.trim() || join(homedir(), ".luban");
    const config = await readJsonObject(join(home, "config.json"));
    const remoteRaw = config.remote && typeof config.remote === "object" && !Array.isArray(config.remote)
      ? config.remote as Record<string, unknown>
      : {};

    const configuredRelay = typeof remoteRaw.relay_url === "string" ? remoteRaw.relay_url : "";
    const relayInput = options.relay?.trim() || configuredRelay.trim() || process.env.LUBAN_RELAY_PUBLIC_URL?.trim()
      || (process.stdin.isTTY ? await promptLine("中继地址（https://…）: ") : "");
    if (!relayInput) throw new Error("缺少中继地址：加 --relay https://…");
    const relayUrl = normalizeRelayUrl(relayInput);
    const parsedRelay = new URL(relayUrl);
    if (parsedRelay.protocol !== "https:" && !LOOPBACK.has(parsedRelay.hostname)) {
      throw new Error("账号登录必须使用 HTTPS；只有本机回环地址允许 HTTP");
    }

    const token = options.deviceToken?.trim() || "";
    if (token) {
      const saved = await saveRelayDeviceToken({ home, relayUrl, token, writeConfig: options.config });
      process.stdout.write(`中继 ${saved.relayUrl}\n`);
      process.stdout.write(`设备令牌已保存到 ${saved.envPath}（权限 600）\n`);
      process.stdout.write(saved.wroteConfig
        ? `已写入 ${saved.configPath}：remote.enabled=true\n`
        : "未修改 config.json；需要手动加载该环境文件\n");
      return 0;
    }

    let email = options.email?.trim() || "";
    if (!email) email = (await promptLine("邮箱: ")).trim();
    if (!email) throw new Error("缺少邮箱：加 --email you@example.com");
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/u.test(email)) throw new Error("邮箱格式不正确，请重新运行");
    process.stdout.write(`邮箱已记录：${email}\n`);

    const password = options.passwordStdin
      ? await readStdinText()
      : process.stdin.isTTY
        ? await promptHidden("密码（输入不显示，回车确认）: ")
        : "";
    if (!password) throw new Error("缺少密码：在终端运行，或使用 --password-stdin 从标准输入读取");
    if (options.passwordStdin) process.stdout.write("密码已读取，正在登录…\n");
    else process.stdout.write("正在登录并生成本机设备令牌…\n");

    const saved = await loginRelayAccount({ home, relayUrl, email, password, writeConfig: options.config });
    process.stdout.write(`已登录 ${saved.email}\n`);
    process.stdout.write(`中继 ${saved.relayUrl}\n`);
    process.stdout.write(`设备令牌已保存到 ${saved.envPath}（权限 600）\n`);
    process.stdout.write(saved.wroteConfig
      ? `已写入 ${saved.configPath}：remote.enabled=true\n`
      : "未修改 config.json；需要手动加载该环境文件\n");
    process.stdout.write("注意：新设备令牌会替换账户原来的设备令牌；其他电脑需要重新登录或更新令牌。\n");
    process.stdout.write("现在运行 luban <项目路径>，手机端即可看到这台电脑。\n");
    return 0;
  } catch (error) {
    process.stderr.write(`login failed: ${error instanceof Error ? error.message : String(error)}\n`);
    return 2;
  }
}

/** Print the saved phone credential without exposing the separate node secret. */
async function runToken(argv: string[]): Promise<number> {
  const program = new Command();
  program.name("luban token")
    .description("Show the phone access token and one-tap login link")
    .version(VERSION)
    .option("--env-file <path>", "relay environment file", join(homedir(), ".config/luban/relay.env"))
    .option("--url <url>", "public relay URL (overrides LUBAN_RELAY_PUBLIC_URL)")
    .showHelpAfterError();
  program.parse(argv, { from: "user" });
  const options = program.opts<{ envFile: string; url?: string }>();
  let saved: Record<string, string> = {};
  try {
    for (const line of readFileSync(options.envFile, "utf8").split(/\r?\n/u)) {
      const match = line.match(/^\s*(LUBAN_RELAY_ACCESS_TOKEN|LUBAN_RELAY_PUBLIC_URL)=(.*)\s*$/u);
      if (match) saved[match[1]] = match[2].replace(/^['"]|['"]$/gu, "");
    }
  } catch (error) {
    if (!process.env.LUBAN_RELAY_ACCESS_TOKEN) {
      process.stderr.write(`cannot read ${options.envFile}: ${error instanceof Error ? error.message : String(error)}\n`);
      return 2;
    }
  }
  const token = process.env.LUBAN_RELAY_ACCESS_TOKEN?.trim() || saved.LUBAN_RELAY_ACCESS_TOKEN?.trim();
  const url = options.url?.trim() || process.env.LUBAN_RELAY_PUBLIC_URL?.trim() || saved.LUBAN_RELAY_PUBLIC_URL?.trim();
  if (!token || !url) {
    process.stderr.write("relay access token or public URL is missing; set LUBAN_RELAY_ACCESS_TOKEN and LUBAN_RELAY_PUBLIC_URL in the relay env file\n");
    return 2;
  }
  let parsed: URL;
  try { parsed = new URL(url); } catch { process.stderr.write("invalid relay URL\n"); return 2; }
  if (parsed.protocol !== "https:" && !(parsed.protocol === "http:" && LOOPBACK.has(parsed.hostname))) {
    process.stderr.write("phone login URL must use HTTPS (HTTP is allowed only on loopback)\n");
    return 2;
  }
  process.stdout.write(`手机令牌 ${token}\n手机登录 ${parsed.origin}/login?token=${encodeURIComponent(token)}\n`);
  return 0;
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
  const config = loadConfig({ workspace, model: options.model, seedDefaults: true });
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
    .option("--token <token>", "access token required by the Web backend when it is exposed beyond localhost")
    .option("-y, --yes", "allow write, execute, and network tools without prompts")
    .option("--theme <name>", "terminal color scheme (run /theme in the TUI for the catalog)")
    .option("-p, --prompt <text>", "run once without the TUI")
    .addHelpText("after", "\nCommands:\n  luban web [path]    native Web API + browser workspace + phone console (/m)\n  luban relay         public relay so a phone can drive a node behind NAT\n  luban login relay   sign in to a relay account and enroll this computer\n  luban login codex   sign in to Codex through the official CLI\n  luban serve [path]  native mesh/worker daemon\n  luban report        export daily/weekly/monthly/yearly work across local sessions\n  luban history       search the SQLite mirror of saved sessions\n  luban acp [path]    Agent Client Protocol over stdio (editor integration)\n")
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
    theme: options.theme,
    seedDefaults: true,
  });
  traceBoot("config");
  // Painted before the first frame: the whole UI reads one mutable palette, so
  // setting it here means the TUI never flashes the default scheme.
  const appliedTheme = applyTheme(config.theme, config.themeColors);
  config.theme = appliedTheme.id;
  // Only a name the catalog cannot resolve is worth a warning; an alias such as
  // `--theme light` resolves to a real id and must stay silent.
  if (options.theme && !resolveThemeId(options.theme)) {
    process.stderr.write(`unknown theme: ${options.theme}; using ${appliedTheme.id} (${themeIds().join(", ")})\n`);
  }
  const piped = !process.stdin.isTTY && !options.prompt ? await readStdin() : "";
  const prompt = options.prompt || piped;
  let mesh: MeshRuntime | undefined;
  let web: LubanWebServer | undefined;
  let remoteWeb: LubanWebServer | undefined;
  let remoteTunnel: TunnelClient | undefined;
  let mobileLink: string | undefined;
  // The TUI keeps its own broker: approvals requested by a browser tab are
  // answered there, while in-terminal jobs keep prompting in the TUI itself.
  const approvals = new ApprovalBroker();
  const questions = new QuestionBroker();
  try {
    if (config.mesh.enabled || options.webPort !== undefined || (config.remote.enabled && !prompt)) {
      const runtimeConfig = config.remote.enabled && !prompt
        ? { ...config, mesh: { ...config.mesh, nodeName: `${config.mesh.nodeName}-${process.pid}`, jobsDir: join(config.mesh.jobsDir, "instances", `tui-${process.pid}`) } }
        : config;
      const candidate = new MeshRuntime(runtimeConfig);
      const remoteJobOptions = {
        approve: (tool: ToolDefinition, args: Record<string, unknown>, jobId: string) => approvals.request(jobId, tool, args),
        askUser: (jobId: string, question: import("./core/question.js").UserQuestion, signal: AbortSignal) => questions.request(jobId, question, signal),
        isInteractive: (jobId: string) => Boolean(web?.isInteractiveJob(jobId) || remoteWeb?.isInteractiveJob(jobId)),
        modeFor: (jobId: string) => web?.jobMode(jobId) ?? remoteWeb?.jobMode(jobId) ?? "edits" as const,
      };
      configureRemoteJobs(candidate, config, undefined, remoteJobOptions);
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
        if ((config.remote.enabled && !prompt) || options.webPort !== undefined) {
          const offlineConfig = { ...runtimeConfig, mesh: { ...runtimeConfig.mesh, enabled: false } };
          const offlineRuntime = new MeshRuntime(offlineConfig);
          configureRemoteJobs(offlineRuntime, config, undefined, remoteJobOptions);
          await offlineRuntime.start();
          mesh = offlineRuntime;
        }
      }
    }
    if (options.webPort !== undefined) {
      if (mesh) {
        web = new LubanWebServer(config, mesh, { host: options.webHost, port: options.webPort, approvals, questions });
        const url = await web.start();
        process.stderr.write(`web workspace: ${url}\n`);
      } else {
        process.stderr.write("warning: skipping web workspace because mesh is unavailable\n");
      }
    }
    if (config.remote.enabled && !prompt) {
      const relayUrl = config.remote.relayUrl.trim();
      const nodeToken = process.env[config.remote.nodeTokenEnv]?.trim()
        || readEnvFileValue(config.remote.nodeTokenFile, config.remote.nodeTokenEnv);
      const deviceToken = process.env[config.remote.deviceTokenEnv]?.trim()
        || readEnvFileValue(config.remote.nodeTokenFile, config.remote.deviceTokenEnv);
      if (!relayUrl) {
        process.stderr.write("手机远控未启动：在 ~/.luban/config.json 的 remote.relay_url 中设置中继地址。\n");
      } else if (!nodeToken && !deviceToken) {
        process.stderr.write(`手机远控未启动：令牌文件 ${config.remote.nodeTokenFile} 中缺少 ${config.remote.nodeTokenEnv} 或 ${config.remote.deviceTokenEnv}。\n`);
      } else if (!mesh) {
        process.stderr.write("手机远控未启动：没有可用的本机 Web runtime。\n");
      } else {
        const normalizedRelayUrl = normalizeRelayUrl(relayUrl);
        const parsedRelayUrl = new URL(normalizedRelayUrl);
        if (parsedRelayUrl.protocol !== "https:" && !(parsedRelayUrl.protocol === "http:" && LOOPBACK.has(parsedRelayUrl.hostname))) {
          throw new Error("公网手机远控必须使用 HTTPS 中继地址");
        }
        const localToken = generateToken();
        const phoneToken = generateToken();
        remoteWeb = new LubanWebServer(config, mesh, {
          host: config.remote.host,
          port: config.remote.port,
          approvals,
          questions,
          token: localToken,
        });
        await remoteWeb.start();
        const relayCa = config.remote.relayCa
          ? readFileSync(config.remote.relayCa, "utf8")
          : undefined;
        remoteTunnel = new TunnelClient({
          relayUrl: normalizedRelayUrl,
          nodeToken: nodeToken || "",
          ...(deviceToken ? { deviceToken } : {}),
          deviceId: instanceDeviceId(config.home, config.workspace),
          status: () => readDeviceStatus(config, mesh),
          accessToken: phoneToken,
          localHost: "127.0.0.1",
          localPort: remoteWeb.port,
          localToken,
          name: relayNodeName(mesh.config.mesh.nodeName, config.workspace),
          version: VERSION,
          workspace: config.workspace,
          projects: mesh.projectMap(),
          relayCa,
          // Ink patches console, so a background retry line is written above
          // the frame and the TUI is redrawn. A raw stderr write would move the
          // cursor behind Ink's back and flicker the whole screen.
          log: (message) => console.error(`手机远控：${message}`),
        });
        mobileLink = `${normalizedRelayUrl}/login?token=${encodeURIComponent(phoneToken)}`;
        await remoteTunnel.start();
        process.stderr.write("手机远控已随当前 TUI 启动，输入 /token 查看此实例的登录链接。\n");
      }
    }
    if (prompt) return await runHeadless(config, prompt, mesh);
    traceBoot("mesh");
    if (!process.stdin.isTTY || !process.stdout.isTTY) {
      process.stderr.write("interactive mode requires a TTY; use --prompt for one-shot mode\n");
      return 2;
    }
    const resume = typeof options.resume === "string" ? options.resume : options.resume ? "latest" : undefined;
    // exitOnCtrlC off: Ctrl+C belongs to the app (interrupt a run / copy the
    // last answer), not to the process. Exit is Ctrl+D or /exit.
    //
    // incrementalRendering must stay off. Ink's incremental renderer only keeps
    // its cursor bookkeeping straight in fullscreen mode (frame height >=
    // terminal rows), where it writes the frame without a trailing newline. Our
    // frame is deliberately one row short so Ink never takes the fullscreen
    // clear path (see the root Box in app.tsx), which means Ink appends '\n' and
    // leaves the cursor one row below the last line. The incremental diff then
    // assumes the cursor sits on the last line and rewrites every changed row one
    // row too low, so each keystroke stamps the composer onto a fresh line and
    // the box grows by a row per key. The standard renderer erases with
    // ansiEscapes.eraseLines(previousLineCount), whose count includes that
    // trailing newline, so it redraws in place. terminalOutput turns fixed-height
    // frame erases into row updates on all TTYs, without requiring DECSET 2026.
    traceBoot("render");
    const instance = render(React.createElement(App, { config, mesh, resume, mobileLink }), { stdout: mascotOutput(terminalOutput(process.stdout)), exitOnCtrlC: false, incrementalRendering: false });
    await instance.waitUntilExit();
    return 0;
  } catch (error) {
    process.stderr.write(`startup failed: ${error instanceof Error ? error.message : String(error)}\n`);
    process.stderr.write("Use --no-mesh to run without LAN collaboration, or choose different ports.\n");
    return 2;
  } finally {
    remoteTunnel?.stop();
    await remoteWeb?.stop();
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
  const config = loadConfig({ workspace, model: options.model, allow: options.yes, mesh: false, seedDefaults: true });
  const runners = new Map<string, { runner: AgentRunner; messages: ChatMessage[] }>();
  const server = new AcpServer(workspace, async (sessionId, sessionWorkspace, text, onChunk, signal) => {
    let state = runners.get(sessionId);
    if (!state) {
      const runner = new AgentRunner({ ...config, workspace: sessionWorkspace });
      state = { runner, messages: initialMessages(sessionWorkspace, config.model.name, config.planning, config.kev?.mode) };
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

/**
 * Cold start is dominated by how much the process must read from disk, which is
 * far slower on Windows where every module open passes the antivirus filter.
 * `LUBAN_STARTUP_TRACE=1 luban` prints the phases so a slow machine can be
 * measured instead of guessed at.
 */
function traceBoot(label: string): void {
  if (!process.env.LUBAN_STARTUP_TRACE) return;
  process.stderr.write(`[startup] ${label.padEnd(7)} ${(process.uptime() * 1000).toFixed(0).padStart(5)}ms\n`);
}
// Reaching this line means the whole static import graph is already loaded.
traceBoot("modules");

// Installed before any subsystem starts: without it, one rejected background
// promise ends the process, and a long-lived mesh/web node then appears to peers
// as a port that keeps changing and refusing connections.
installProcessGuard({ label: "luban" });

const command = process.argv[2];
const entry = command === "login" && process.argv[3] === "codex"
  ? new Promise<number>((resolve, reject) => {
      const child = spawn(...codexInvocation(["login"]), { stdio: "inherit" });
      child.on("error", reject);
      child.on("close", (code) => {
        if (code !== 0) return resolve(code ?? 1);
        savePreferredModel(process.env.LUBAN_HOME || join(homedir(), ".luban"), "codex/default")
          .then(() => {
            process.stdout.write("Codex login complete. Luban will use codex/default.\n");
            resolve(0);
          }, reject);
      });
    })
  : command === "login" && process.argv[3] === "relay"
  ? runRelayLogin(process.argv.slice(4))
  : command === "bot"
  ? runBot(process.argv.slice(3))
  : command === "report"
  ? runReport(process.argv.slice(3))
  : command === "web"
  ? runDaemon(process.argv.slice(3), true)
  : command === "serve"
    ? runDaemon(process.argv.slice(3), false)
    : command === "acp"
      ? runAcp(process.argv.slice(3))
      : command === "mesh"
        ? runMeshCheck(process.argv.slice(3))
        : command === "history"
          ? runHistory(process.argv.slice(3))
          : command === "relay"
            ? runRelay(process.argv.slice(3))
            : command === "mcp"
              ? runMcp(process.argv.slice(3))
            : command === "token"
              ? runToken(process.argv.slice(3))
              : main();

entry.then((code) => { process.exitCode = code; }).catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.stack || error.message : String(error)}\n`);
  process.exitCode = 1;
});
