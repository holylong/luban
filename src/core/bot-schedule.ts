/**
 * Turning a sentence into a schedule.
 *
 * The queue only understands `at` + `every`; people say "每天 6 点提醒我" and
 * "5 分钟后提醒我下班". This is the small, deliberately literal layer between
 * the two: it recognises the shapes people actually type, never guesses at
 * anything ambiguous, and returns null so the caller can fall back to "now".
 *
 * Pure and dependency-free so the 造物主 window can run it in the renderer to
 * show the booking it is about to make.
 */
export interface BotSchedule {
  /** First execution, epoch ms. */
  at: number;
  /** Repeat interval, epoch ms; undefined means a one-off. */
  every?: number;
  /** How the booking reads back to the user, e.g. `每天 06:00`. */
  label: string;
}

const DAY = 86_400_000;
const HOUR = 3_600_000;
const MINUTE = 60_000;
const WEEK = ["日", "一", "二", "三", "四", "五", "六"];
const CN_DIGITS: Record<string, number> = { 一: 1, 二: 2, 两: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9 };

function number(raw: string): number {
  if (/^\d+$/.test(raw)) return Number(raw);
  if (raw === "十") return 10;
  if (raw.startsWith("十")) return 10 + (CN_DIGITS[raw.slice(1)] ?? 0);
  if (raw.endsWith("十")) return (CN_DIGITS[raw.slice(0, -1)] ?? 1) * 10;
  if (raw.includes("十")) {
    const [tens, ones] = raw.split("十");
    return (CN_DIGITS[tens] ?? 1) * 10 + (CN_DIGITS[ones] ?? 0);
  }
  return CN_DIGITS[raw] ?? Number.NaN;
}

/** Digits people type for a number, as a ready-made character class. */
const NUMERAL = "[0-9一二三四五六七八九十两]";

function pad(value: number): string {
  return String(value).padStart(2, "0");
}

/** `下午 3 点`, `6 点 半`, `18:30`, `早上 9 点` → 24h hour and minute. */
function parseTime(text: string): { hour: number; minute: number } | null {
  const words = /(凌晨|早上|早晨|上午|中午|下午|傍晚|晚上|夜里)?\s*([0-9]{1,2}|[一二三四五六七八九十两]{1,3})\s*(?:点|时|:|：)\s*(半|[0-9]{1,2})?/.exec(text);
  if (words) {
    const period = words[1] ?? "";
    let hour = number(words[2]);
    let minute = words[3] === "半" ? 30 : words[3] ? number(words[3]) : 0;
    if (!Number.isFinite(hour) || hour > 24 || !Number.isFinite(minute) || minute > 59) return null;
    if (["下午", "傍晚", "晚上", "夜里"].includes(period) && hour < 12) hour += 12;
    if (period === "中午" && hour < 11) hour += 12;
    if (period === "凌晨" && hour === 12) hour = 0;
    if (hour === 24) hour = 0;
    return { hour, minute };
  }
  const clock = /([0-9]{1,2}):([0-9]{2})/.exec(text);
  if (clock) {
    const hour = Number(clock[1]);
    const minute = Number(clock[2]);
    if (hour > 23 || minute > 59) return null;
    return { hour, minute };
  }
  return null;
}

function todayAt(base: Date, hour: number, minute: number, dayOffset = 0): number {
  return new Date(base.getFullYear(), base.getMonth(), base.getDate() + dayOffset, hour, minute, 0, 0).getTime();
}

/**
 * Recognise a schedule in one sentence. Order matters: an explicit "5 分钟后"
 * outranks "每天", because "每天 5 分钟后" is not something people mean.
 */
export function parseSchedule(text: string, now = Date.now()): BotSchedule | null {
  const source = String(text || "");
  if (!source.trim()) return null;
  const base = new Date(now);

  const after = new RegExp(`(${NUMERAL}{1,3})\\s*个?\\s*分钟\\s*后`).exec(source);
  if (after) {
    const minutes = number(after[1]);
    if (Number.isFinite(minutes) && minutes > 0) return { at: now + minutes * MINUTE, label: `${minutes} 分钟后` };
  }
  const afterHour = new RegExp(`(${NUMERAL}{1,3})\\s*个?\\s*小时\\s*后`).exec(source);
  if (afterHour) {
    const hours = number(afterHour[1]);
    if (Number.isFinite(hours) && hours > 0) return { at: now + hours * HOUR, label: `${hours} 小时后` };
  }

  if (/每\s*小时/.test(source)) return { at: now, every: HOUR, label: "每小时" };
  const everyMinutes = new RegExp(`每\\s*(${NUMERAL}{1,3})\\s*分钟`).exec(source);
  if (everyMinutes) {
    const minutes = number(everyMinutes[1]);
    if (Number.isFinite(minutes) && minutes > 0) return { at: now, every: Math.max(MINUTE, minutes * MINUTE), label: `每 ${minutes} 分钟` };
  }
  const everyHours = new RegExp(`每\\s*(${NUMERAL}{1,3})\\s*个?\\s*小时`).exec(source);
  if (everyHours) {
    const hours = number(everyHours[1]);
    if (Number.isFinite(hours) && hours > 0) return { at: now, every: hours * HOUR, label: `每 ${hours} 小时` };
  }

  const weekly = new RegExp(`每\\s*(?:周|星期|礼拜)\\s*([一二三四五六日天0-9])`).exec(source);
  if (weekly) {
    const key = weekly[1] === "天" ? "日" : weekly[1];
    const index = /^\d$/.test(key) ? Number(key) % 7 : WEEK.indexOf(key);
    const time = parseTime(source);
    if (index >= 0 && time) {
      let delta = (index - base.getDay() + 7) % 7;
      let at = todayAt(base, time.hour, time.minute, delta);
      if (at <= now) at = todayAt(base, time.hour, time.minute, delta + 7);
      return { at, every: 7 * DAY, label: `每周${WEEK[index]} ${pad(time.hour)}:${pad(time.minute)}` };
    }
  }

  const daily = /每天|每日|天天/.test(source);
  const tomorrow = /明天|明早|明晚/.test(source);
  const time = parseTime(source);
  if ((daily || tomorrow) && time) {
    let at: number;
    if (daily) {
      at = todayAt(base, time.hour, time.minute);
      if (at <= now) at = todayAt(base, time.hour, time.minute, 1);
    } else {
      at = todayAt(base, time.hour, time.minute, 1);
    }
    const label = daily ? `每天 ${pad(time.hour)}:${pad(time.minute)}` : `明天 ${pad(time.hour)}:${pad(time.minute)}`;
    return daily ? { at, every: DAY, label } : { at, label };
  }

  const today = /今天|今晚|今早/.test(source);
  if (today && time) {
    const at = todayAt(base, time.hour, time.minute);
    return { at: at > now ? at : at + DAY, label: `今天 ${pad(time.hour)}:${pad(time.minute)}` };
  }
  return null;
}
