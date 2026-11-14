/* A booking must read back the way it will fire.
 *
 * The model decides what a sentence means and calls `schedule`; these two
 * helpers are what the window shows for the row that lands. A wrong label here
 * means the user trusts a task that will never fire. */
import { describe, expect, it } from "vitest";
import { dayClock, nextRunLabel, scheduleLabel } from "./creator-schedule";

const MINUTE = 60_000;
const HOUR = 3_600_000;
const DAY = 86_400_000;
/** Thursday 2026-11-12 08:00 local. */
const NOW = new Date(2026, 10, 12, 8, 0, 0).getTime();
const at = (hour: number, minute = 0, dayOffset = 0): number =>
  new Date(2026, 10, 12 + dayOffset, hour, minute, 0).getTime();

describe("scheduleLabel", () => {
  it("names a daily job by its clock time", () => {
    expect(scheduleLabel({ at: at(6), every: DAY, status: "queued" })).toBe("每天 06:00");
  });

  it("names a weekly job with its weekday", () => {
    // 2026-11-16 is a Monday.
    expect(scheduleLabel({ at: at(9, 30, 4), every: 7 * DAY, status: "queued" })).toBe("每周一 09:30");
  });

  it("keeps long intervals in hours and short ones in minutes", () => {
    expect(scheduleLabel({ at: NOW, every: 6 * HOUR, status: "queued" })).toBe("每 6 小时");
    expect(scheduleLabel({ at: NOW, every: 90 * MINUTE, status: "queued" })).toBe("每 90 分钟");
  });

  it("marks a one-off booking with its date so it cannot be mistaken for a repeat", () => {
    expect(scheduleLabel({ at: at(6, 0, 1), status: "queued" })).toMatch(/^一次 · /u);
  });
});

describe("nextRunLabel", () => {
  it("says 下次 with a readable time while waiting", () => {
    expect(nextRunLabel({ at: at(6), nextAt: at(6, 0, 1), status: "queued" }, NOW)).toBe("下次 11/13 06:00");
  });

  it("says 今天 for a task later the same day", () => {
    expect(nextRunLabel({ at: at(23), nextAt: at(23), status: "queued" }, NOW)).toBe("下次 今天 23:00");
  });

  it("says 马上执行 once the deadline has passed and the worker has not picked it up", () => {
    expect(nextRunLabel({ at: at(7), status: "queued" }, NOW)).toBe("马上执行");
  });

  it("falls back to the last status for finished work", () => {
    expect(nextRunLabel({ at: NOW, status: "completed" }, NOW)).toBe("已完成");
    expect(nextRunLabel({ at: NOW, status: "failed" }, NOW)).toBe("失败");
  });
});

describe("dayClock", () => {
  it("uses 今天 only for today", () => {
    expect(dayClock(at(23), NOW)).toBe("今天 23:00");
    expect(dayClock(at(6, 0, 1), NOW)).toBe("11/13 06:00");
  });
});
