#!/usr/bin/env node
/**
 * 造物主 window smoke test.
 *
 * Electron cannot run headless, but it can render offscreen and hand back a
 * PNG. This seeds a throwaway LUBAN_HOME with the three states the window has to
 * draw (queued with a repeat interval, running, finished with a result), asks the
 * real app to screenshot itself with `--smoke`, and checks the pixels are not blank.
 *
 * Usage: npm run build && npm run smoke:creator
 */
import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const repo = join(dirname(fileURLToPath(import.meta.url)), "..");
const home = mkdtempSync(join(tmpdir(), "luban-creator-"));
const tasks = join(home, "bot", "tasks");
const shot = join(home, "creator.png");
const now = Date.now();

const seed = [
  {
    id: "11111111-1111-4111-8111-111111111111",
    prompt: "检查禅道上本周新增的 bug，把能复现的整理成一份清单发给我",
    status: "running",
    every: 6 * 3600_000,
    startedAt: now - 90_000,
  },
  {
    id: "22222222-2222-4222-8222-222222222222",
    prompt: "扫描 GitLab 上 luban 仓库的新提交，有变更就打 tag 并写 release notes",
    status: "completed",
    every: 3600_000,
    finishedAt: now - 600_000,
    result: "## 结论\n\n**本次发布**：`v2.4.4` 已打上并附带说明。\n\n**改了什么**：\n\n- 回复排版改为按小节渲染\n- 修复手机端无法接答终端提问\n",
  },
  {
    id: "33333333-3333-4333-8333-333333333333",
    prompt: "每晚 23:00 汇总今天的工作区改动，写成日报",
    status: "queued",
    at: now + 3600_000,
  },
];

for (const task of seed) {
  const directory = join(tasks, task.id);
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  writeFileSync(join(directory, "request.json"), JSON.stringify({
    id: task.id, prompt: task.prompt, workspace: join(home, "workspace"), at: task.at ?? now - 900_000,
    every: task.every, timeout: 900_000,
  }, null, 2));
  writeFileSync(join(directory, "state.json"), JSON.stringify({
    status: task.status, nextAt: task.at ?? now, startedAt: task.startedAt,
    finishedAt: task.finishedAt, result: task.result,
  }, null, 2));
}
mkdirSync(join(home, "workspace"), { recursive: true });

const electron = join(repo, "node_modules", "electron", "cli.js");
const child = spawn(process.execPath, [electron, join(repo, "apps", "creator"), "--smoke", shot], {
  env: { ...process.env, LUBAN_HOME: home },
  stdio: ["ignore", "pipe", "pipe"],
});
let log = "";
child.stdout.on("data", chunk => { log += chunk; });
child.stderr.on("data", chunk => { log += chunk; });

const code = await new Promise(resolve => child.on("exit", resolve));
if (code !== 0) {
  console.error(log.trim().split("\n").slice(-12).join("\n"));
  console.error(`造物主退出码 ${code}`);
  rmSync(home, { recursive: true, force: true });
  process.exit(1);
}
if (!statSync(shot).size) {
  console.error("截图是空的");
  process.exit(1);
}
const png = readFileSync(shot);
// A blank window compresses to almost nothing; a drawn one does not.
if (png.length < 12_000) {
  console.error(`截图疑似空白：${png.length} 字节`);
  process.exit(1);
}
// The window must show the queue it was handed, not just some dark pixels.
const text = readFileSync(shot.replace(/\.png$/u, ".txt"), "utf8");
const expected = [
  "造物主",
  "检查禅道上本周新增的 bug",          // running row
  "每晚 23:00 汇总今天的工作区改动",     // queued row with a repeat interval
];
for (const needle of expected) {
  if (!text.includes(needle)) {
    console.error(`窗口里没有「${needle}」：\n${text.slice(0, 600)}`);
    process.exit(1);
  }
}
console.log(`creator window ok: ${shot} (${png.length} bytes, ${expected.length} rows verified)`);
console.log(`  window text: ${text.split("\n").filter(Boolean).join(" | ").slice(0, 220)}`);
