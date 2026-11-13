#!/usr/bin/env node
/**
 * 造物主 · 操控电脑 smoke test.
 *
 * The window's control panel is only real if a sentence typed into it ends with
 * something happening on screen. This starts the app offscreen, feeds one prompt
 * through the same DriveBridge the 输入框 uses (approving whatever the session
 * asks for, like a user's first 「允许」), then captures the panel and asserts it
 * drew actions, a screenshot thumbnail and an answer.
 *
 * Usage: npm run build && npm run smoke:creator:drive ["在计算器里算 6*7"]
 */
import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const repo = join(dirname(fileURLToPath(import.meta.url)), "..");
// The session needs the same credentials a normal run uses, and those live in the
// real home (provider auth is not all in config.json), so this smoke runs against
// it. It still skips the queue worker, so no tokens are spent on tasks.
const home = process.env.LUBAN_HOME || join(homedir(), ".luban");
const workspace = mkdtempSync(join(tmpdir(), "luban-drive-ws-"));
const shot = join(mkdtempSync(join(tmpdir(), "luban-creator-drive-")), "creator-drive.png");
const prompt = process.argv[2] || "在计算器里算 6*7，把屏幕上的结果显示给我";

const electron = join(repo, "node_modules", "electron", "cli.js");
const child = spawn(process.execPath, [electron, join(repo, "apps", "creator"), "--smoke", shot], {
  env: {
    ...process.env,
    LUBAN_HOME: home,
    CREATOR_SMOKE_DRIVE: prompt,
    CREATOR_SMOKE_WORKSPACE: workspace,
  },
  stdio: ["ignore", "pipe", "pipe"],
});
let log = "";
child.stdout.on("data", chunk => { log += chunk; });
child.stderr.on("data", chunk => { log += chunk; });

const code = await new Promise(resolve => child.on("exit", resolve));
if (code !== 0) {
  console.error(log.trim().split("\n").slice(-15).join("\n"));
  console.error(`造物主退出码 ${code}`);
  process.exit(1);
}

const driveShot = shot.replace(/\.png$/u, "-drive.png");
const png = readFileSync(driveShot);
const text = readFileSync(driveShot.replace(/\.png$/u, ".txt"), "utf8");
const rects = JSON.parse(readFileSync(driveShot.replace(/\.png$/u, ".rects.json"), "utf8"));

const problems = [];
if (!statSync(driveShot).size) problems.push("操控截图是空的");
if (!rects.acts.length) problems.push("面板里没有任何动作");
if (!rects.acts.some(act => act.text.includes("点击") || act.text.includes("按键") || act.text.includes("打开"))) {
  problems.push("面板里没有点击/按键");
}
if (!rects.shots.length) problems.push("没有把截图贴进面板");
if (!rects.shots.every(shot => shot.w > 40 && shot.h > 20)) problems.push("截图缩略图尺寸不对");
if (!(rects.log && rects.log.h > 100)) problems.push("操控记录区没有高度");
if (!text.trim()) problems.push("面板没有文字");
if (problems.length) {
  console.error(problems.join("；"));
  console.error(JSON.stringify(rects, null, 2).slice(0, 1500));
  process.exit(1);
}

console.log(`creator 操控 ok: ${driveShot} (${png.length} 字节)`);
console.log(`  动作 ${rects.acts.length} 条 / 截图 ${rects.shots.length} 张 / 审批 ${rects.asks.length} 条 / 记录区高 ${rects.log.h}`);
console.log(`  第一条动作: ${rects.acts[0].text.replaceAll("\n", " ").slice(0, 90)}`);
console.log(`  面板文字: ${text.split("\n").filter(Boolean).join(" | ").slice(0, 260)}`);
