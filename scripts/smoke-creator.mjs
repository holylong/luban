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
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

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
    every: 86_400_000,
    // Tonight at 23:00, so the schedule label reads 每天 23:00 like the prompt says.
    at: (() => { const tonight = new Date(now); tonight.setHours(23, 0, 0, 0); return tonight.getTime() > now ? tonight.getTime() : tonight.getTime() + 86_400_000; })(),
  },
  {
    id: "44444444-4444-4444-8444-444444444444",
    prompt: "5 分钟后提醒我下班",
    status: "queued",
    at: now + 5 * 60_000,
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

// Cross-run memory for the 记忆 drawer: written through the real writer in
// dist/core/memory.js, so the smoke proves the same Markdown a task would leave.
// A hand-written fixture would agree with the window and disagree with the code.
const { rememberFact, noteRun } = await import(pathToFileURL(join(repo, "dist", "core", "memory.js")).href);
const workspace = join(home, "workspace");
const startedAt = now - 3600_000;
await rememberFact(home, workspace, "禅道 bug 项目的 id 是 42", startedAt);
await rememberFact(home, workspace, "用户偏好 pnpm，不要用 npm", startedAt + 60_000);
await noteRun(home, workspace, "扫了本周新增 bug，找到 3 个。", startedAt + 120_000);
await noteRun(home, workspace, "整理了文档里的过期截图。", startedAt + 180_000);

// A standing 允许 and the 操控 switch: creator.json is what makes them survive a
// relaunch, so the window is handed a real one instead of an empty default.
writeFileSync(join(home, "creator.json"), JSON.stringify({ computer: true, allowed: ["computer", "bash"] }, null, 2));

// Run history for the finished job: the 计划 drawer reads these rows, so seeding
// them is what proves the drawer lists executions instead of only the last one.
const runs = [
  { from: now - 3 * 3600_000, to: now - 3 * 3600_000 + 240_000, status: "completed", nextAt: now - 2 * 3600_000,
    usage: { input: 41_000, output: 3_200, calls: 7 },
    result: "## 结论\n\n扫到 4 个新提交，其中一个修复了登录超时。已打 tag `v2.4.3`。" },
  { from: now - 2 * 3600_000 - 60_000, to: now - 2 * 3600_000 + 180_000, status: "failed", nextAt: now - 3600_000,
    usage: { input: 12_000, output: 400, calls: 2 },
    result: "推送失败：远端返回 403，需要检查 token 权限。" },
];
writeFileSync(join(tasks, "22222222-2222-4222-8222-222222222222", "runs.jsonl"),
  runs.map(row => JSON.stringify(row)).join("\n") + "\n");

const electron = join(repo, "node_modules", "electron", "cli.js");
const child = spawn(process.execPath, [electron, join(repo, "apps", "creator"), "--smoke", shot], {
  env: { ...process.env, LUBAN_HOME: home, CREATOR_SMOKE_PLANS: "1", CREATOR_SMOKE_APPROVALS: "1", CREATOR_SMOKE_FORGET: "1", CREATOR_SMOKE_MEMORY: "1" },
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
  "Creator",
  "检查禅道上本周新增的 bug",          // running row
  "每晚 23:00 汇总今天的工作区改动",     // queued row with a repeat interval
];
for (const needle of expected) {
  if (!text.includes(needle)) {
    console.error(`窗口里没有「${needle}」：\n${text.slice(0, 600)}`);
    process.exit(1);
  }
}
// The 计划 drawer must list every job with its schedule, next fire and history.
// The queue tab's composer is one sentence box: no 现在/定时/每隔 form, no
// locally guessed schedule. Anything else means a regex came back to life.
const queueJson = shot.replace(/\.png$/u, "-queue.json");
if (existsSync(queueJson)) {
  const composer = JSON.parse(readFileSync(queueJson, "utf8"));
  if (!composer.composer) {
    console.error(`任务记录页没有输入卡：${JSON.stringify(composer)}`);
    process.exit(1);
  }
  if (composer.controls.length) {
    console.error(`输入卡里又出现了时间控件：${composer.controls.join(", ")}`);
    process.exit(1);
  }
  if (composer.parsed) {
    console.error(`输入卡又自己猜排期了：「${composer.parsed}」`);
    process.exit(1);
  }
}
// The 操控 switch the human left on has to be on-screen after a relaunch.
if (!text.includes("电脑操控已开启")) {
  console.error(`重启后操控开关没有恢复：\n${text.slice(0, 600)}`);
  process.exit(1);
}
// 授权 has to show what is remembered, and one click has to clear it for good.
const approvalsJson = shot.replace(/\.png$/u, "-approvals.json");
if (existsSync(approvalsJson)) {
  const approvals = JSON.parse(readFileSync(approvalsJson, "utf8"));
  if (!approvals.remembered.includes("computer、bash") || !approvals.forget) {
    console.error(`授权 页没有列出已记住的授权：${JSON.stringify(approvals)}`);
    process.exit(1);
  }
  const forgot = JSON.parse(readFileSync(approvalsJson.replace(/\.json$/u, "-forgot.json"), "utf8"));
  if (forgot.page !== false || forgot.stored.allowed.length) {
    console.error(`清空已记住的授权没有生效：${JSON.stringify(forgot)}`);
    process.exit(1);
  }
  if (forgot.stored.computer !== true) {
    console.error(`清空授权时把操控开关也关了：${JSON.stringify(forgot)}`);
    process.exit(1);
  }
  console.log(`  approvals: remembered computer、bash → cleared to ${JSON.stringify(forgot.stored.allowed)}, switch kept on`);
} else {
  console.error("授权 页没有渲染出截图");
  process.exit(1);
}
// 记忆 has to show the facts the model kept and a journal line per run, with a
// clear button that reaches the file rather than only the React tree.
const memoryJson = shot.replace(/\.png$/u, "-memory.json");
if (existsSync(memoryJson)) {
  const memory = JSON.parse(readFileSync(memoryJson, "utf8"));
  if (memory.title !== "项目记忆") {
    console.error(`记忆 抽屉标题不对：${JSON.stringify(memory.title)}`);
    process.exit(1);
  }
  const shown = `${memory.projects.join(" ")} ${memory.rows.join(" ")}`;
  for (const needle of ["禅道 bug 项目的 id 是 42", "用户偏好 pnpm", "扫了本周新增 bug", "整理了文档"]) {
    if (!shown.includes(needle)) {
      console.error(`记忆 抽屉里没有「${needle}」：\n${JSON.stringify(memory, null, 2).slice(0, 700)}`);
      process.exit(1);
    }
  }
  if (!memory.clear.some(label => label.includes("清除"))) {
    console.error(`记忆 抽屉没有清除入口：${JSON.stringify(memory.clear)}`);
    process.exit(1);
  }
  if (!memory.drawer || memory.drawer.w < 320) {
    console.error(`记忆 抽屉没有展开：${JSON.stringify(memory.drawer)}`);
    process.exit(1);
  }
  console.log(`  memory: ${memory.rows.length} rows in ${memory.projects.length} project(s), w=${memory.drawer.w}`);
} else {
  console.error("记忆 抽屉没有渲染出截图");
  process.exit(1);
}

const plansShot = shot.replace(/\.png$/u, "-plans.png");
const plans = JSON.parse(readFileSync(plansShot.replace(/\.png$/u, ".rects.json"), "utf8"));
const drawerText = readFileSync(plansShot.replace(/\.png$/u, ".rects.json"), "utf8");
const haystack = `${plans.title} ${drawerText}`;
for (const needle of ["全部计划", "循环任务", "一次任务", "每天 23:00", "每 6 小时", "一次 · ", "次执行"]) {
  if (!haystack.includes(needle)) {
    console.error(`计划 抽屉里没有「${needle}」：\n${JSON.stringify(plans, null, 2).slice(0, 900)}`);
    process.exit(1);
  }
}
if (!plans.runs.length) {
  console.error(`计划 抽屉没有列出执行记录：\n${JSON.stringify(plans, null, 2).slice(0, 700)}`);
  process.exit(1);
}
if (!plans.drawer || plans.drawer.w < 320) {
  console.error(`计划 抽屉没有展开：${JSON.stringify(plans.drawer)}`);
  process.exit(1);
}
console.log(`plan drawer ok: ${plansShot} (${plans.plans.length} plans, ${plans.runs.length} runs, w=${plans.drawer.w})`);
console.log(`  metas: ${plans.metas.slice(0, 3).join(" ‖ ")}`);
console.log(`  runs:  ${plans.runs.slice(0, 2).join(" ‖ ")}`);
console.log(`creator window ok: ${shot} (${png.length} bytes, ${expected.length} rows verified)`);
console.log(`  window text: ${text.split("\n").filter(Boolean).join(" | ").slice(0, 220)}`);
