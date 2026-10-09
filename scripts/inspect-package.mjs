/** List the top-level contents of a built Windows package zip. */
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, rmSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(fileURLToPath(new URL("..", import.meta.url)));
const zipName = process.argv[2];
if (!zipName) throw new Error("usage: node scripts/inspect-package.mjs <zip>");
const verify = join(root, "release", ".inspect");
rmSync(verify, { recursive: true, force: true });
mkdirSync(verify, { recursive: true });

const zip = join(root, "release", zipName);
const extract = spawnSync("tar.exe", ["-xf", zip, "-C", verify], { stdio: ["ignore", "pipe", "pipe"] });
if (extract.status !== 0) {
  process.stderr.write(`extract failed (${extract.status}): ${extract.stderr?.toString()}\n`);
  process.exit(1);
}
const folder = join(verify, readdirSync(verify)[0]);
for (const entry of readdirSync(folder).sort()) {
  const stats = statSync(join(folder, entry));
  const size = stats.isDirectory() ? "<dir>" : `${(stats.size / 1024 / 1024).toFixed(1)} MB`;
  process.stdout.write(`${existsSync(join(folder, entry)) ? "ok " : "!! "}${entry} ${size}\n`);
}
rmSync(verify, { recursive: true, force: true });