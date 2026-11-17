/* `luban drive --stdio`: the control session behind the 造物主 window.
 *
 * One process per window. Events go out as JSON lines on stdout, commands come
 * back as JSON lines on stdin — the same shape as the computer helper, for the
 * same reason: an Electron main process can pipe JSONL reliably, while argv
 * cannot carry Chinese, quotes and newlines without a quoting bug.
 *
 *   → {"type":"say","text":"打开计算器并截图"}
 *   ← {"type":"tool","id":"…","label":"点击 720,430"}
 *   → {"type":"approve","id":"…","allow":true}
 *   ← {"type":"turn-end","id":"turn-1",…}
 *
 * stdout is *only* JSONL. Anything else a subsystem prints to stdout (relay
 * notices, model warnings) is rerouted to stderr here, so a log line can never
 * be mistaken for an event.
 */

import { Command } from "commander";
import { createInterface } from "node:readline";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { DriveSession, type DriveCommand, type DriveEvent } from "./drive.js";
import { loadConfig } from "./config.js";

/**
 * Write one event. Serialised synchronously and newline-terminated so a consumer
 * reading line-by-line never sees half a frame.
 */
export function encodeEvent(event: DriveEvent): string {
  return `${JSON.stringify(event)}\n`;
}

/**
 * Read the standing 允许 list the window hands to a fresh session. Anything that
 * is not a plain tool name is dropped: this list only ever skips a prompt the
 * human already answered, so a malformed value must not widen it.
 */
export function parseAllowlist(value: string | undefined): string[] {
  const names = String(value ?? "").split(",").map(name => name.trim()).filter(name => /^[a-z_][\w-]{0,63}$/iu.test(name));
  return [...new Set(names)].slice(0, 64);
}

/** Parse one stdin line. Unknown or malformed commands are dropped, not fatal. */
export function decodeCommand(line: string): DriveCommand | undefined {
  const text = line.trim();
  if (!text) return undefined;
  let parsed: unknown;
  try { parsed = JSON.parse(text); } catch { return undefined; }
  if (!parsed || typeof parsed !== "object") return undefined;
  const value = parsed as Record<string, unknown>;
  if (value.type === "say" && typeof value.text === "string" && value.text.trim()) return { type: "say", text: value.text };
  if (value.type === "approve" && typeof value.id === "string") return { type: "approve", id: value.id, allow: value.allow === true };
  if (value.type === "stop") return { type: "stop" };
  if (value.type === "status") return { type: "status" };
  return undefined;
}

export async function runDrive(argv: string[]): Promise<number> {
  const program = new Command();
  program
    .name("luban drive")
    .description("Conversational computer control over stdio (JSONL commands in, events out)")
    .argument("[path]", "workspace directory", process.cwd())
    .option("-m, --model <provider/model>", "override the active model")
    .option("--no-computer", "never touch the desktop, even if LUBAN_COMPUTER=1")
    .showHelpAfterError();
  program.parse(argv, { from: "user" });
  const workspace = resolve((program.args[0] ?? process.cwd()) as string);
  const options = program.opts<{ model?: string; computer: boolean }>();
  if (!existsSync(workspace)) {
    process.stderr.write(`workspace does not exist: ${workspace}\n`);
    return 2;
  }

  // Only this file's writer may touch stdout; everything else goes to stderr.
  const write = (event: DriveEvent): void => { process.stdout.write(encodeEvent(event)); };
  const config = loadConfig({ workspace, model: options.model, mesh: false, seedDefaults: true });
  if (!options.computer) process.env.LUBAN_COMPUTER = "0";

  const allowed = new Set(parseAllowlist(process.env.LUBAN_DRIVE_ALLOW));
  const session = new DriveSession({
    home: config.home, workspace, model: options.model, emit: write,
    isPreapproved: tool => allowed.has(tool),
  });
  await session.open();
  write({ type: "status", text: "会话已就绪：说一句话就行——整理文档、设个闹钟，或者让我去操作屏幕" });

  const input = createInterface({ input: process.stdin, crlfDelay: Infinity });
  await pumpCommands(session, write, input, { workspace, model: config.model.id });
  session.close();
  return 0;
}

/** The slice of DriveSession the command pump uses; tests pass a fake. */
export interface CommandTarget {
  busy: boolean;
  state: unknown;
  say(text: string): Promise<void>;
  approve(id: string, allow: boolean): boolean;
  stop(): void;
}

/**
 * Read JSONL commands until input closes.
 *
 * Approvals and stops are answered *inside* the read loop, not queued: a `say`
 * turn blocks on the approval it just raised, so putting the approve behind it
 * deadlocks every turn that touches the screen. Everything else stays serial.
 */
export async function pumpCommands(
  session: CommandTarget,
  write: (event: DriveEvent) => void,
  lines: AsyncIterable<string>,
  info: { workspace: string; model: string },
): Promise<void> {
  let queue = Promise.resolve();
  for await (const line of lines) {
    const command = decodeCommand(line);
    if (!command) continue;
    if (command.type === "approve") {
      if (!session.approve(command.id, command.allow)) write({ type: "status", text: `审批 ${command.id} 已过期` });
      continue;
    }
    if (command.type === "stop") {
      session.stop();
      continue;
    }
    // Everything else is serialised: two turns must never run against one runner.
    queue = queue.then(async () => {
      try {
        if (command.type === "say") {
          if (session.busy) { write({ type: "error", text: "上一个任务还在执行，先停止" }); return; }
          await session.say(command.text);
        } else if (command.type === "status") {
          write({ type: "ready", workspace: info.workspace, model: info.model, computer: session.state } as DriveEvent);
        }
      } catch (error) {
        write({ type: "error", text: error instanceof Error ? error.message : String(error) });
      }
    });
  }
  await queue;
}
