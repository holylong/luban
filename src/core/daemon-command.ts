/* `luban daemon` — the command surface of the always-on backend.
 *
 * The daemon itself is just `luban web … --daemon-child`; this module only
 * reports on it, starts it detached and stops it. Everything it prints is meant
 * to be pasted into a phone: the link carries the token because a phone that
 * has to type one is a phone that never connects.
 */
import { existsSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { Command } from "commander";
import { VERSION } from "../version.js";
import {
  clearDaemonState, daemonInfo, daemonLogTail, daemonPaths, ensureDaemon, probeDaemon,
  processAlive, readDaemonState, registerDaemonProject, stopDaemon, type DaemonState,
} from "../web/daemon.js";

function daemonHome(): string {
  return resolve(process.env.LUBAN_HOME || join(homedir(), ".luban"));
}

export function phoneLink(state: DaemonState): string {
  return `http://127.0.0.1:${state.port}/m/?token=${encodeURIComponent(state.token)}`;
}

function elapsed(startedAt: number): string {
  const minutes = Math.max(0, Math.round((Date.now() - startedAt) / 60_000));
  if (minutes < 60) return `${minutes} 分钟`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} 小时 ${minutes % 60} 分钟`;
  return `${Math.floor(hours / 24)} 天 ${hours % 24} 小时`;
}

function describe(state: DaemonState): string {
  return `pid ${state.pid} · 127.0.0.1:${state.port} · 已运行 ${elapsed(state.startedAt)}`;
}

/** One shared check so `status`, `start` and `add` agree on what live means. */
async function liveState(home: string): Promise<{ state: DaemonState; alive: boolean } | undefined> {
  const state = readDaemonState(home);
  if (!state) return undefined;
  // A leftover file from a crash or a reboot is not a daemon; drop it so the
  // next start does not have to reason about a pid that cannot come back.
  if (!processAlive(state.pid)) { clearDaemonState(home); return undefined; }
  return { state, alive: await probeDaemon(state) };
}

async function printProjects(state: DaemonState): Promise<void> {
  const info = await daemonInfo(state);
  const entries = Object.entries(info?.projects ?? {});
  if (!info) {
    process.stdout.write("（常驻服务没有回答项目列表；用 luban daemon logs 看日志）\n");
    return;
  }
  if (!entries.length) {
    process.stdout.write("项目：还没有。用 luban daemon add <目录> 加一个。\n");
    return;
  }
  process.stdout.write(`项目（${entries.length}）：\n`);
  for (const [name, path] of entries) process.stdout.write(`  ${name}  ${path}\n`);
}

export async function runDaemonCommand(argv: string[]): Promise<number> {
  const home = daemonHome();
  let code = 0;
  const program = new Command();
  program
    .name("luban daemon")
    .description("One always-on backend per machine: the phone keeps working after the terminal and the app are closed")
    .version(VERSION)
    .showHelpAfterError();

  program.command("status", { isDefault: true })
    .description("是否在运行、开着哪些项目、手机链接是什么")
    .action(async () => {
      const found = await liveState(home);
      if (!found) {
        process.stdout.write("常驻服务未运行。luban daemon start 启动（或打开任意一个 luban 会话，它会自动起）。\n");
        return;
      }
      const { state, alive } = found;
      if (!alive) {
        code = 1;
        process.stdout.write(`常驻服务没有响应（${describe(state)}）。\n日志：${daemonPaths(home).log}\n`);
        return;
      }
      const info = await daemonInfo(state);
      process.stdout.write(`常驻服务：运行中（${describe(state)}）\n`);
      process.stdout.write(`版本 ${(info?.version ?? state.version) || "?"}${info?.model ? ` · 模型 ${info.model}` : ""}\n`);
      if (state.workspace) process.stdout.write(`出生目录 ${state.workspace}\n`);
      process.stdout.write(`手机链接 ${phoneLink(state)}\n`);
      await printProjects(state);
    });

  program.command("start")
    .description("后台启动（已经在跑就复用，并把目录加进项目列表）")
    .argument("[path]", "workspace 目录", process.cwd())
    .action(async (path: string) => {
      const workspace = resolve(path);
      if (!existsSync(workspace) || !statSync(workspace).isDirectory()) {
        process.stderr.write(`目录不存在：${workspace}\n`);
        code = 2;
        return;
      }
      const result = await ensureDaemon(home, {
        workspace, version: VERSION,
        log: (message) => process.stdout.write(`${message}\n`),
      });
      process.stdout.write(`${result.started ? "已启动" : "已在运行"}（${describe(result.state)}）\n`);
      process.stdout.write(`手机链接 ${phoneLink(result.state)}\n`);
      await printProjects(result.state);
    });

  program.command("add")
    .description("把一个目录加进手机能看到的工作区，不启动第二个服务")
    .argument("<path>", "workspace 目录")
    .action(async (path: string) => {
      const workspace = resolve(path);
      if (!existsSync(workspace) || !statSync(workspace).isDirectory()) {
        process.stderr.write(`目录不存在：${workspace}\n`);
        code = 2;
        return;
      }
      const found = await liveState(home);
      if (!found?.alive) {
        process.stderr.write("常驻服务没在运行；先用 luban daemon start 启动。\n");
        code = 1;
        return;
      }
      const project = await registerDaemonProject(found.state, workspace);
      if (!project) {
        process.stderr.write("注册失败：服务没有接受这个目录。\n");
        code = 1;
        return;
      }
      process.stdout.write(`已加入项目：${project}  ${workspace}\n`);
    });

  program.command("stop")
    .description("停掉常驻服务（手机随即断开）")
    .action(async () => {
      const stopped = await stopDaemon(home);
      process.stdout.write(stopped ? "常驻服务已停止。\n" : "常驻服务本来就没在运行。\n");
    });

  program.command("logs")
    .description("看常驻服务的日志尾部")
    .option("-n, --lines <n>", "行数", (value) => Number(value), 60)
    .action((options: { lines: number }) => {
      const tail = daemonLogTail(home, options.lines);
      process.stdout.write(tail ? `${tail}\n` : `没有日志：${daemonPaths(home).log}\n`);
    });

  program.command("url")
    .description("只打印带令牌的手机链接")
    .action(async () => {
      const found = await liveState(home);
      if (!found?.alive) {
        process.stderr.write("常驻服务没在运行。\n");
        code = 1;
        return;
      }
      process.stdout.write(`${phoneLink(found.state)}\n`);
    });

  await program.parseAsync(argv, { from: "user" });
  return code;
}
