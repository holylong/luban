import { spawn } from "node:child_process";
import { closeSync, existsSync, mkdirSync, openSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { BotQueue, type BotTask } from "./bot.js";
/**
 * "5 分钟后提醒我下班" belongs in luban's own queue, not in the system calendar.
 *
 * The old protocol told the model to write an event into 日历/提醒事项 through
 * osascript. That is macOS-only, invisible to `luban bot list`, impossible to
 * cancel from the window, and leaves nothing behind on a Windows or Ubuntu box.
 * Everything a reminder needs already exists here: `BotQueue` fires at a wall
 * clock time on whatever machine the worker runs on, and a `notify` task needs
 * no model call at all.
 *
 * This module is pure arithmetic plus a thin queue/spawn wrapper so the tool,
 * the CLI and the tests all describe the same schedule.
 */

/** Title every reminder notification carries. */
export const REMIND_TITLE = "luban 提醒";

/** Units as people write them, including the Chinese ones this app hears daily. */
const UNITS: Record<string, number> = {
  ms: 1, 毫秒: 1,
  s: 1000, sec: 1000, secs: 1000, second: 1000, seconds: 1000, 秒: 1000,
  m: 60_000, min: 60_000, mins: 60_000, minute: 60_000, minutes: 60_000, 分: 60_000, 分钟: 60_000,
  h: 3_600_000, hr: 3_600_000, hrs: 3_600_000, hour: 3_600_000, hours: 3_600_000, 小时: 3_600_000, 个小时: 3_600_000,
  d: 86_400_000, day: 86_400_000, days: 86_400_000, 天: 86_400_000,
};

/** "5m", "90s", "1h30m", "5 分钟", "1.5h" → milliseconds. Throws on anything else. */
export function parseDelay(input: string): number {
  const text = String(input ?? "").trim().toLowerCase().replace(/\s+/gu, "");
  if (!text) throw new Error("empty duration");
  const pattern = /(\d+(?:\.\d+)?)(ms|seconds?|secs?|s|minutes?|mins?|m|hours?|hrs?|h|days?|d|毫秒|小时|个小时|分钟|分|秒|天)/gu;
  let total = 0;
  let consumed = "";
  for (const match of text.matchAll(pattern)) {
    const unit = UNITS[match[2]];
    if (!unit) throw new Error(`unknown unit: ${match[2]}`);
    total += Number(match[1]) * unit;
    consumed += match[0];
  }
  // A bare number is not a duration: "in: 5" could mean 5 seconds or 5 days.
  if (!total || consumed !== text) throw new Error(`cannot read "${input}" as a duration (try 5m, 90s, 2h)`);
  return Math.round(total);
}

export interface ScheduleRequest {
  text: string;
  /** Absolute time in ms; wins over `in`. */
  at?: number;
  /** Delay before firing, e.g. "5m". */
  in?: string;
  /** Repeat interval; the task re-queues after each successful run. */
  every?: string;
  /** Same interval already in milliseconds (the window and the reminder path). */
  everyMs?: number;
  /** True for a pure reminder: notify at that time instead of running an agent. */
  notify?: boolean;
}

export interface ScheduledReminder {
  task: BotTask;
  /** What the model/user is told, so both read the same words. */
  summary: string;
}

const pad = (value: number) => String(value).padStart(2, "0");

/**
 * "今天 18:05", "11月14日 08:00" — local time, because the person reading it is
 * sitting at the machine whose clock the worker will use.
 */
export function describeMoment(at: number, now = Date.now()): string {
  const when = new Date(at);
  const today = new Date(now);
  const time = `${pad(when.getHours())}:${pad(when.getMinutes())}`;
  const sameDay = when.getFullYear() === today.getFullYear() && when.getMonth() === today.getMonth() && when.getDate() === today.getDate();
  if (sameDay) return `今天 ${time}`;
  const tomorrow = new Date(now);
  tomorrow.setDate(tomorrow.getDate() + 1);
  if (when.getFullYear() === tomorrow.getFullYear() && when.getMonth() === tomorrow.getMonth() && when.getDate() === tomorrow.getDate()) return `明天 ${time}`;
  return `${when.getMonth() + 1}月${when.getDate()}日 ${time}`;
}

/** Resolve a request into the fields the queue stores. */
export function resolveSchedule(request: ScheduleRequest, now = Date.now()): { at: number; every?: number } {
  if (!request.text.trim()) throw new Error("reminder text cannot be empty");
  if (request.at !== undefined && !Number.isFinite(request.at)) throw new Error("`at` must be an ISO timestamp");
  const at = request.at !== undefined ? request.at : request.in ? now + parseDelay(request.in) : now;
  const every = request.every ? parseDelay(request.every) : request.everyMs;
  if (every !== undefined && every < 60_000) throw new Error("repeat interval must be at least 60 seconds");
  return { at, ...(every === undefined ? {} : { every }) };
}

/**
 * Put the reminder in the durable queue.
 *
 * Deliberately no "does the worker run?" cleverness here — the caller reports
 * that separately, because a reminder is still real when the worker is stopped
 * and will fire on the next start.
 */
export async function scheduleReminder(home: string, workspace: string, request: ScheduleRequest, now = Date.now()): Promise<ScheduledReminder> {
  const { at, every } = resolveSchedule(request, now);
  const queue = new BotQueue(home);
  const notify = request.notify === true;
  const task = await queue.add({
    prompt: request.text.trim(),
    workspace: resolve(workspace),
    at,
    ...(every === undefined ? {} : { every }),
    timeout: 15 * 60 * 1000,
    kind: notify ? "notify" : "agent",
  });
  const when = describeMoment(at, now);
  const repeat = every === undefined ? "" : `，之后每 ${Math.round(every / 60_000)} 分钟一次`;
  const summary = `${when}${repeat}${notify ? " 发系统通知" : " 到你点跑一次"}`;
  return { task, summary };
}

export interface WorkerFile {
  pid?: number;
  /** True when a live process owns the lock, not just a leftover file. */
  running: boolean;
  launchAgent: boolean;
}

/** Read the worker lock without trusting it: a stale pid file is not a worker. */
export function workerFile(home: string): WorkerFile {
  const lock = join(home, "bot", "worker.lock");
  const launchAgent = ["~/Library/LaunchAgents/com.luban.bot.plist", join(home, "bot", "service.plist")].some(path => existsSync(path.replace(/^~\//u, `${process.env.HOME ?? ""}/`)));
  let pid: number | undefined;
  try {
    const value = Number(readFileSync(join(lock, "pid"), "utf8").trim());
    if (Number.isInteger(value) && value > 0) pid = value;
  } catch { /* no lock yet */ }
  let running = false;
  if (pid !== undefined) {
    try { process.kill(pid, 0); running = true; } catch { running = false; }
  }
  return { ...(pid === undefined ? {} : { pid }), running, launchAgent };
}

export interface EnsureWorkerResult extends WorkerFile {
  started: boolean;
  reason: "already-running" | "launch-agent" | "spawned" | "no-entry";
  log?: string;
}

/**
 * Start the queue worker when nothing else owns it.
 *
 * A reminder is only heard if somebody is polling the queue; the tray app does
 * this for the window, and a CLI-only machine needs the same insurance. The
 * LaunchAgent case is left alone on purpose — two workers would fight for the
 * lock.
 */
export function ensureBotWorker(home: string, entry = process.argv[1], binary = process.execPath): EnsureWorkerResult {
  const current = workerFile(home);
  if (current.running) return { ...current, started: false, reason: "already-running" };
  if (current.launchAgent) return { ...current, started: false, reason: "launch-agent" };
  // Only a built CLI can be asked to run the worker: no guessing at test
  // runners or a `tsx src/cli.tsx` dev session, where the flag means nothing.
  if (!entry || !/(?:^|[\\/])cli\.(?:js|mjs)$/u.test(entry)) return { ...current, started: false, reason: "no-entry" };
  const directory = join(home, "bot");
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const log = join(directory, "worker.log");
  const fd = openSync(log, "a", 0o600);
  try {
    const child = spawn(binary, [entry, "bot", "run"], {
      env: { ...process.env, LUBAN_HOME: home },
      detached: true,
      stdio: ["ignore", fd, fd],
    });
    child.unref();
    return { ...workerFile(home), started: true, reason: "spawned", log };
  } finally {
    // The child inherited its own descriptor; the parent must not keep the log open.
    try { closeSync(fd); } catch { /* the spawn already failed */ }
  }
}
