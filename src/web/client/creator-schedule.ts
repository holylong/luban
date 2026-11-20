/* Schedule wording for the 造物主 window.
 *
 * The window's whole job is answering "did my 6:00 job get booked, and when does
 * it fire next", so the two strings below are load-bearing: they are what the user
 * checks the booking against. They stay pure functions (no React, no clock read
 * from inside) so the phrasing can be asserted in tests rather than eyeballed. */

const MINUTE = 60_000;
const HOUR = 3_600_000;
const DAY = 86_400_000;
const WEEK = ["日", "一", "二", "三", "四", "五", "六"];

/** The subset of a queue row that scheduling wording needs. */
export interface ScheduleTask {
  at: number;
  every?: number;
  nextAt?: number;
  status: string;
  startedAt?: number;
  finishedAt?: number;
}

const STATUS: Record<string, string> = {
  queued: "排队中", running: "执行中", completed: "已完成", failed: "失败",
  cancelled: "已取消", interrupted: "被中断", paused: "已暂停",
};

export function clock(at?: number): string {
  if (!at) return "";
  const date = new Date(at);
  return `${String(date.getHours()).padStart(2, "0")}:${String(date.getMinutes()).padStart(2, "0")}`;
}

/** `今天 06:00` for today, `11/14 06:00` otherwise — never a bare timestamp. */
export function dayClock(at?: number, now = Date.now()): string {
  if (!at) return "";
  const date = new Date(at);
  const sameDay = date.toDateString() === new Date(now).toDateString();
  return sameDay ? `今天 ${clock(at)}` : `${date.getMonth() + 1}/${date.getDate()} ${clock(at)}`;
}

/** How the booking reads back: `每天 06:00`, `每周一 09:00`, `每 6 小时`, or one-off. */
export function scheduleLabel(task: ScheduleTask): string {
  const every = task.every ?? 0;
  if (every >= 7 * DAY && every % (7 * DAY) === 0) {
    const weeks = every / (7 * DAY);
    return weeks === 1 ? `每周${WEEK[new Date(task.at).getDay()]} ${clock(task.at)}` : `每 ${weeks} 周`;
  }
  if (every >= DAY && every % DAY === 0) return `每天 ${clock(task.at)}`;
  if (every >= HOUR && every % HOUR === 0) return `每 ${every / HOUR} 小时`;
  if (every >= MINUTE) return `每 ${Math.round(every / MINUTE)} 分钟`;
  return `一次 · ${dayClock(task.at)}`;
}

/** Repeat options a person can pick when editing a task, in the order they read. */
export const REPEAT_OPTIONS: Array<{ value: number; label: string }> = [
  { value: 0, label: "只跑一次" },
  { value: DAY, label: "每天" },
  { value: 7 * DAY, label: "每周" },
  { value: 6 * HOUR, label: "每 6 小时" },
  { value: 30 * MINUTE, label: "每 30 分钟" },
];

/** What the edit form starts from: the task's own repeat and clock, never a default. */
export interface TaskDraft { prompt: string; repeat: number; time: string }

export function taskDraft(task: { prompt: string; at: number; every?: number }): TaskDraft {
  return { prompt: task.prompt, repeat: task.every ?? 0, time: clock(task.at) };
}

/** Today at `HH:MM`, or tomorrow when that moment has already passed. */
export function nextClock(time: string, now: number): number {
  const match = /^(\d{1,2}):(\d{2})$/u.exec(time.trim());
  const date = new Date(now);
  if (!match) return now;
  const hours = Math.min(23, Math.max(0, Number(match[1])));
  const minutes = Math.min(59, Math.max(0, Number(match[2])));
  date.setHours(hours, minutes, 0, 0);
  if (date.getTime() <= now) date.setDate(date.getDate() + 1);
  return date.getTime();
}

/**
 * The patch the edit form submits.
 *
 * Sub-daily repeats start now rather than at the painted clock time: "每 6 小时"
 * means "from here on", and re-dating it to 06:00 would either run late or fire
 * twice. Daily and weekly keep the clock the person chose.
 */
export function draftPatch(draft: TaskDraft, now: number): { prompt: string; every: number | null; at: number } {
  const prompt = draft.prompt.trim();
  if (!prompt) throw new Error("任务内容不能为空");
  const repeat = Number(draft.repeat) || 0;
  const at = repeat === 0 || repeat >= DAY ? nextClock(draft.time, now) : now;
  return { prompt, every: repeat === 0 ? null : repeat, at };
}

/** The next moment this task will actually run, in words the user can check. */
export function nextRunLabel(task: ScheduleTask, now: number): string {
  if (task.status === "running") return `正在执行（${clock(task.startedAt)} 开始）`;
  if (task.status === "queued") {
    const at = task.nextAt ?? task.at;
    if (!at) return "等待排期";
    return at <= now ? "马上执行" : `下次 ${dayClock(at, now)}`;
  }
  return STATUS[task.status] ?? task.status;
}
