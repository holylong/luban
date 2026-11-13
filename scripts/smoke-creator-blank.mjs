#!/usr/bin/env node
/**
 * 造物主 window smoke test — the empty-queue state.
 *
 * `smoke:creator` seeds a queue and checks the list; this one seeds nothing so the
 * hero title and the three suggestion pills have to be drawn instead.
 *
 * Usage: npm run build && npm run smoke:creator:blank
 */
import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const repo = join(dirname(fileURLToPath(import.meta.url)), "..");
const home = mkdtempSync(join(tmpdir(), "luban-creator-blank-"));
const shot = join(home, "creator.png");
mkdirSync(join(home, "bot", "tasks"), { recursive: true, mode: 0o700 });
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
if (code !== 0) { console.error(log.slice(-2000)); process.exit(1); }
const png = readFileSync(shot);
console.log("shot", shot, png.length, "bytes");
console.log("text:", readFileSync(shot.replace(/\.png$/u, ".txt"), "utf8").split("\n").filter(Boolean).join(" | "));
console.log("home", home, statSync(home).isDirectory());
