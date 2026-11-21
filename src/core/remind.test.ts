import { mkdtemp, mkdir, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { BotQueue } from "./bot.js";
import {
  describeMoment, ensureBotWorker, parseDelay, resolveSchedule, scheduleReminder, workerFile,
} from "./remind.js";
import { createTools } from "./tools.js";

/**
 * "5 分钟后提醒我下班" used to become an AppleScript event in 日历/提醒事项.
 * These tests pin the replacement: one durable queue entry that fires on every
 * platform, and a `notify` task that needs no model call.
 */

let home: string;
beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), "luban-remind-"));
});

describe("parseDelay", () => {
  it("reads the forms people actually type", () => {
    expect(parseDelay("5m")).toBe(300_000);
    expect(parseDelay("90s")).toBe(90_000);
    expect(parseDelay("2h")).toBe(7_200_000);
    expect(parseDelay("1h30m")).toBe(5_400_000);
    expect(parseDelay("5 分钟")).toBe(300_000);
    expect(parseDelay("0.5h")).toBe(1_800_000);
    expect(parseDelay("1天")).toBe(86_400_000);
  });

  it("refuses values that are not a duration", () => {
    expect(() => parseDelay("5")).toThrow(/duration/u);
    expect(() => parseDelay("soon")).toThrow(/duration/u);
    expect(() => parseDelay("")).toThrow(/duration/u);
    expect(() => parseDelay("5 分钟后")).toThrow(/duration/u);
  });
});

describe("resolveSchedule", () => {
  it("turns a delay into an absolute time from the given clock", () => {
    const now = Date.UTC(2026, 10, 13, 9, 0, 0);
    expect(resolveSchedule({ text: "提醒我下班", in: "5m" }, now)).toEqual({ at: now + 300_000 });
  });

  it("prefers an explicit timestamp and keeps a repeat interval", () => {
    const at = Date.UTC(2026, 10, 14, 0, 0, 0);
    expect(resolveSchedule({ text: "喝水", at, every: "30m" })).toEqual({ at, every: 1_800_000 });
  });

  it("rejects a repeat faster than the queue can honour", () => {
    expect(() => resolveSchedule({ text: "喝水", every: "10s" })).toThrow(/60/u);
  });
});

describe("describeMoment", () => {
  it("speaks in today/tomorrow instead of a raw timestamp", () => {
    const now = new Date(2026, 10, 13, 17, 30).getTime();
    expect(describeMoment(new Date(2026, 10, 13, 17, 35).getTime(), now)).toBe("今天 17:35");
    expect(describeMoment(new Date(2026, 10, 14, 8, 0).getTime(), now)).toBe("明天 08:00");
    expect(describeMoment(new Date(2026, 10, 20, 8, 0).getTime(), now)).toBe("11月20日 08:00");
  });
});

describe("scheduleReminder", () => {
  it("writes a notify task the queue can fire without a model", async () => {
    const now = Date.now();
    const scheduled = await scheduleReminder(home, home, { text: "提醒我下班", in: "5m", notify: true }, now);
    const rows = await new BotQueue(home).list();
    expect(rows).toHaveLength(1);
    expect(rows[0].task.kind).toBe("notify");
    expect(rows[0].task.prompt).toBe("提醒我下班");
    expect(rows[0].task.at).toBe(now + 300_000);
    expect(scheduled.summary).toMatch(/发系统通知$/u);
    expect(scheduled.task.id).toBe(rows[0].task.id);
  });

  it("leaves work that needs a model as an ordinary agent task", async () => {
    await scheduleReminder(home, join(home, "repo"), { text: "汇总今天的提交", in: "1h" });
    const [row] = await new BotQueue(home).list();
    expect(row.task.kind).toBe("agent");
    expect(row.task.workspace).toBe(join(home, "repo"));
  });
});

describe("worker detection", () => {
  it("does not mistake a stale lock for a running worker", async () => {
    const lock = join(home, "bot", "worker.lock");
    await mkdir(lock, { recursive: true });
    await writeFile(join(lock, "pid"), "999999");
    expect(workerFile(home)).toMatchObject({ pid: 999999, running: false });
  });

  it("sees a live worker and leaves it alone", async () => {
    const lock = join(home, "bot", "worker.lock");
    await mkdir(lock, { recursive: true });
    await writeFile(join(lock, "pid"), String(process.pid));
    expect(ensureBotWorker(home)).toMatchObject({ running: true, started: false, reason: "already-running" });
  });

  it("refuses to spawn without a built CLI entry point", () => {
    // A test runner (or `tsx src/cli.tsx`) is not the CLI: spawning it with
    // `bot run` would start something unrelated.
    expect(ensureBotWorker(home, "/tmp/vitest.mjs").reason).toBe("no-entry");
    expect(ensureBotWorker(home, undefined).reason).toBe("no-entry");
  });

  it("finds the CLI behind a symlinked launcher", async () => {
    // A global install runs `…/bin/luban`, a symlink: the worker still has to be
    // spawned from the real dist/cli.js, not skipped as a dev loader.
    const bin = join(home, "bin");
    await mkdir(bin, { recursive: true });
    const cli = join(home, "dist", "cli.js");
    await mkdir(join(home, "dist"), { recursive: true });
    await writeFile(cli, "#!/usr/bin/env node\n");
    await symlink(cli, join(bin, "luban"));
    const started = ensureBotWorker(home, join(bin, "luban"), "/bin/true");
    expect(started.reason).toBe("spawned");
    expect(started.started).toBe(true);
  });
});

describe("schedule tool", () => {
  it("queues a reminder and tells the model where it went", async () => {
    const config = { workspace: home, home, project: "test", model: { name: "test" }, permissionMode: "allow", theme: "auto" } as unknown as Parameters<typeof createTools>[0];
    const tools = createTools(config);
    const tool = tools.get("schedule");
    expect(tool).toBeDefined();
    const result = await tool!.execute({ text: "提醒我下班", in: "5m", notify: true }, new AbortController().signal);
    expect(result).toContain("提醒我下班");
    expect(result).toContain("luban bot cancel");
    expect(result).toContain("系统日历");
    const [row] = await new BotQueue(home).list();
    expect(row.task.kind).toBe("notify");
    expect(row.task.at).toBeGreaterThan(Date.now() + 4 * 60_000);
  });

  it("rejects an absolute time without a timezone", async () => {
    const config = { workspace: home, home, project: "test", model: { name: "test" }, permissionMode: "allow", theme: "auto" } as unknown as Parameters<typeof createTools>[0];
    const tool = createTools(config).get("schedule")!;
    await expect(tool.execute({ text: "喝水", at: "明天早上" }, new AbortController().signal)).rejects.toThrow(/ISO/u);
    expect(await new BotQueue(home).list()).toEqual([]);
  });
});
