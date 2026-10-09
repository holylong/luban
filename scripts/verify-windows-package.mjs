/** Extract a Windows package zip and run its entry point to verify it works. */
import { spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(fileURLToPath(new URL("..", import.meta.url)));
const kind = process.argv[2] || "cli";
const version = JSON.parse(readFileSync(join(root, "package.json"), "utf8")).version;
const zip = join(root, "release", `luban-${kind}-${version}-win-x64.zip`);
const verify = join(root, "release", ".verify");
rmSync(verify, { recursive: true, force: true });
mkdirSync(verify, { recursive: true });

const extract = spawnSync("tar.exe", ["-xf", zip, "-C", verify], { stdio: "inherit" });
if (extract.status !== 0) throw new Error(`extract failed (${extract.status})`);

const folder = join(verify, `luban-${kind}-${version}-win-x64`);
const launcher = join(folder, kind === "desktop" ? "luban-desktop.cmd" : "luban.cmd");
const check = spawnSync(launcher, ["--version"], {
  cwd: folder,
  stdio: ["ignore", "pipe", "pipe"],
  shell: process.platform === "win32",
});
process.stdout.write(`launcher: ${launcher}\nstatus: ${check.status}\n`);
if (check.error) process.stdout.write(`error: ${check.error.message}\n`);
process.stdout.write(`stdout: ${check.stdout?.toString().trim() || "(empty)"}\n`);
process.stderr.write(`stderr: ${check.stderr?.toString().trim() || "(empty)"}\n`);
rmSync(verify, { recursive: true, force: true });
process.exit(check.status ?? 1);