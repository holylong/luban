import { describe, expect, it } from "vitest";
import { parseSchedule } from "./bot-schedule.js";

/* A Thursday morning: 2026-11-12 is a Thursday. Local time on purpose — every
 * rule is expressed in the user's own clock, not UTC. */
const NOW = new Date(2026, 10, 12, 10, 0, 0, 0).getTime();
const at = (day: number, hour: number, minute = 0) => new Date(2026, 10, day, hour, minute, 0, 0).getTime();
const DAY = 86_400_000;

describe("parseSchedule", () => {
  it("books 每天 6 点 as a daily repeat starting tomorrow morning", () => {
    const schedule = parseSchedule("每天6点提醒我", NOW);
    expect(schedule).toEqual({ at: at(13, 6), every: DAY, label: "每天 06:00" });
  });

  it("still books today when the hour has not passed yet", () => {
    const schedule = parseSchedule("每天 18 点提醒我下班", NOW);
    expect(schedule).toEqual({ at: at(12, 18), every: DAY, label: "每天 18:00" });
  });

  it("books 5 分钟后 as a one-off delay", () => {
    const schedule = parseSchedule("5分钟后提醒我下班", NOW);
    expect(schedule?.at).toBe(NOW + 5 * 60_000);
    expect(schedule?.every).toBeUndefined();
    expect(schedule?.label).toBe("5 分钟后");
  });

  it("accepts Chinese numerals and 半", () => {
    expect(parseSchedule("每天六点半提醒我", NOW)?.at).toBe(at(13, 6, 30));
    expect(parseSchedule("两小时后提醒我", NOW)?.at).toBe(NOW + 2 * 3_600_000);
  });

  it("books 每 30 分钟 and 每小时 as repeats starting now", () => {
    expect(parseSchedule("每30分钟检查一次 CI", NOW)).toEqual({ at: NOW, every: 30 * 60_000, label: "每 30 分钟" });
    expect(parseSchedule("每小时扫描 buglist", NOW)).toEqual({ at: NOW, every: 3_600_000, label: "每小时" });
    expect(parseSchedule("每 6 小时扫一次 buglist", NOW)?.every).toBe(6 * 3_600_000);
  });

  it("reads 明天下午3点 as tomorrow 15:00", () => {
    const schedule = parseSchedule("明天下午3点提醒我", NOW);
    expect(schedule?.at).toBe(at(13, 15));
    expect(schedule?.every).toBeUndefined();
  });

  it("reads 每周一 9 点 as next Monday with a weekly repeat", () => {
    const schedule = parseSchedule("每周一9点发周报", NOW);
    expect(schedule?.at).toBe(at(16, 9));
    expect(schedule?.every).toBe(7 * DAY);
    expect(schedule?.label).toBe("每周一 09:00");
  });

  it("uses 18:30 clock form", () => {
    expect(parseSchedule("每天 18:30 汇总今天的改动", NOW)?.at).toBe(at(12, 18, 30));
  });

  it("returns null when the sentence has no schedule", () => {
    expect(parseSchedule("把这个仓库的测试跑一遍", NOW)).toBeNull();
    expect(parseSchedule("", NOW)).toBeNull();
    expect(parseSchedule("每天提醒我", NOW)).toBeNull();
  });
});
