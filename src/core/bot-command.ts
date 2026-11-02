import { Command } from "commander";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { AgentRunner, initialMessages } from "./agent.js";
import { BotQueue, type BotExecute } from "./bot.js";
import { loadConfig } from "./config.js";
import { SessionStore } from "./session-store.js";
import { BotPermissions } from "./bot-permissions.js";
import { readdir } from "node:fs/promises";

export function botLaunchAgent(executable: string, cli: string, home: string, path: string): string {
  const xml = (value: string) => value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;");
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>Label</key><string>dev.luban.bot</string>
<key>ProgramArguments</key><array>${[executable, cli, "bot", "run"].map(value => `<string>${xml(value)}</string>`).join("")}</array>
<key>EnvironmentVariables</key><dict><key>LUBAN_HOME</key><string>${xml(home)}</string><key>PATH</key><string>${xml(path)}</string></dict>
<key>RunAtLoad</key><true/><key>KeepAlive</key><true/><key>ThrottleInterval</key><integer>10</integer>
<key>StandardOutPath</key><string>${xml(join(home, "bot", "service.log"))}</string>
<key>StandardErrorPath</key><string>${xml(join(home, "bot", "service.log"))}</string>
</dict></plist>\n`;
}

const execute: BotExecute = async (task, signal) => {
  const config = loadConfig({ workspace: task.workspace, model: task.model, mesh: false });
  // Never inherit LUBAN_ALLOW_TOOLS or project-config approval overrides in an unattended process.
  config.permissionMode = "ask";
  config.permissions = { allow: [], deny: config.permissions?.deny ?? [] };
  config.sandbox = { ...config.sandbox, allowOutsideWorkspace: false };
  const store = new SessionStore(config.home);
  const messages = [...initialMessages(config.workspace, config.model.name, config.planning), { role: "user" as const, content: task.prompt }];
  const session = store.create(config.project, config.workspace, "agent", config.model.id, messages);
  const runner = new AgentRunner(config);
  const permissions = new BotPermissions(config.home);
  let denied = false;
  try {
    const result = await runner.run(messages, "agent", signal, event => {
      if (event.type === "error") process.stderr.write(`${task.id}: ${event.text}\n`);
    }, async (tool, args) => {
      let reason = "No matching unexpired grant";
      try {
        // Mandatory explicit-confirmation operations must not be silently preapproved.
        if (!tool.approvalOnceOnly && await permissions.allows(task.workspace, tool.name, args)) return "once";
        if (tool.approvalOnceOnly) reason = "Operation requires interactive confirmation";
      } catch (error) { reason = `Permission policy unavailable: ${String(error)}`; }
      denied = true;
      const id = await permissions.request(task.id, task.workspace, tool.name, args, reason);
      process.stderr.write(`Permission needed: ${id} (${tool.name}); inspect luban bot requests\n`);
      return "deny";
    });
    session.messages = result.messages;
    await store.save(session);
    return { ok: result.ok && !denied, text: `${result.text}${denied ? "\nOperation requires interactive approval; run this task in luban." : ""}\nSession: ${session.id}` };
  } finally { runner.close(); }
};

export async function runBot(argv: string[]): Promise<number> {
  const home = resolve(process.env.LUBAN_HOME || join(homedir(), ".luban"));
  const queue = new BotQueue(home);
  const program = new Command().name("luban bot").description("Persistent local task bot with explicit permission grants");
  program.command("permissions").description("Initialize and validate permissions file; never overwrites grants").action(async () => {
    const permissions = new BotPermissions(home);
    await permissions.init();
    await permissions.read();
    process.stdout.write(`${permissions.policyPath}\n`);
  });
  program.command("requests").description("Show recorded permission requests; grants are edited by the user").action(async () => {
    const permissions = new BotPermissions(home);
    await permissions.init();
    const requests = [];
    for (const file of await readdir(permissions.requestsPath)) {
      if (/^[0-9a-f-]{36}\.json$/.test(file)) requests.push(JSON.parse(await readFile(join(permissions.requestsPath, file), "utf8")));
    }
    process.stdout.write(`${JSON.stringify(requests, null, 2)}\n`);
  });
  program.command("add <prompt>").option("-w, --workspace <path>", "workspace", process.cwd())
    .option("-m, --model <id>", "model override").option("--at <ISO-date>", "first execution time (include timezone)")
    .option("--every <seconds>", "repeat after successful completion, minimum 60 seconds")
    .option("--timeout <seconds>", "execution deadline", "900")
    .action(async (prompt, options) => {
      const task = await queue.add({ prompt, workspace: options.workspace, model: options.model,
        at: options.at ? Date.parse(options.at) : Date.now(), every: options.every === undefined ? undefined : Number(options.every) * 1000,
        timeout: Number(options.timeout) * 1000 });
      process.stdout.write(`Queued ${task.id}\n`);
    });
  program.command("list").description("Task states and most recent results (JSON)").action(async () => {
    process.stdout.write(`${JSON.stringify(await queue.list(), null, 2)}\n`);
  });
  program.command("cancel <id>").action(async id => { await queue.cancel(id); process.stdout.write(`Cancelled ${id}\n`); });
  program.command("service").description("Print a macOS LaunchAgent plist; does not install or start it").action(async () => {
    if (process.platform !== "darwin") throw new Error("LaunchAgent is macOS-only; use bot run with your service manager");
    if (!process.argv[1]?.endsWith(".js")) throw new Error("Build first and run node dist/cli.js bot service");
    await mkdir(join(home, "bot"), { recursive: true, mode: 0o700 });
    process.stdout.write(botLaunchAgent(process.execPath, resolve(process.argv[1]), home, process.env.PATH || "/usr/bin:/bin"));
  });
  program.command("run").description("Run serial worker; Ctrl+C/SIGTERM stops safely").action(async () => {
    const lock = join(home, "bot", "worker.lock");
    await mkdir(join(home, "bot"), { recursive: true, mode: 0o700 });
    // Exclusive directory acquisition: never guess that an existing lock is stale.
    try { await mkdir(lock); } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EEXIST") {
        const owner = await readFile(join(lock, "pid"), "utf8").catch(() => "unknown");
        throw new Error(`Bot worker lock exists (PID ${owner}). If the worker crashed, verify it is stopped before removing ${lock}.`);
      }
      throw error;
    }
    const stop = new AbortController();
    const shutdown = () => stop.abort();
    process.once("SIGINT", shutdown); process.once("SIGTERM", shutdown);
    try {
      await writeFile(join(lock, "pid"), String(process.pid));
      await queue.recover();
      process.stdout.write(`Bot ready · ${queue.directory}\n`);
      while (!stop.signal.aborted) {
        await queue.tick(execute, stop.signal);
        await delay(1000, undefined, { signal: stop.signal }).catch(error => { if (!stop.signal.aborted) throw error; });
      }
    } finally {
      process.removeListener("SIGINT", shutdown); process.removeListener("SIGTERM", shutdown);
      await rm(lock, { recursive: true });
    }
  });
  await program.parseAsync(argv, { from: "user" });
  return 0;
}
