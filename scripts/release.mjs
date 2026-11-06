/** Native release packaging entry point. Never commits, tags, or uploads. */
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { readFile, stat, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
/** @type {Record<string, string>} */
const aliases = { linux: "linux", windows: "windows", win32: "windows", macos: "macos", mac: "macos", darwin: "macos" };
const help = `Usage: npm run release -- [--platform auto|linux|windows|macos] [--kind all|cli|desktop] [--dry-run]

Defaults: current OS, CLI and Desktop. Outputs go to release/ with SHA-256 checksums.
Build on the target OS using its native Node architecture; cross-compilation is not supported.
Install dependencies with npm ci first. No git changes, tags, or uploads are performed.
`;

/** @param {string[]} args @param {string} host @param {string} arch @param {string} version */
export function releasePlan(args, host = process.platform, arch = process.arch, version = "0.0.0") {
  let platform = "auto";
  let kind = "all";
  let dryRun = false;
  for (let index = 0; index < args.length; index++) {
    const arg = args[index];
    if (arg === "--help" || arg === "-h") return { help: true };
    if (arg === "--dry-run") { dryRun = true; continue; }
    if (arg !== "--platform" && arg !== "--kind") throw new Error(`Unknown option: ${arg}`);
    const value = args[++index];
    if (!value || value.startsWith("--")) throw new Error(`Missing value for ${arg}`);
    if (arg === "--platform") platform = value;
    else kind = value;
  }
  platform = platform === "auto" ? aliases[host] : aliases[platform];
  if (!platform || typeof platform !== "string") throw new Error("Unsupported platform; choose linux, windows, or macos");
  if (!["all", "cli", "desktop"].includes(kind)) throw new Error("--kind must be all, cli, or desktop");
  if (platform !== aliases[host]) throw new Error(`Build ${platform} on a ${platform} host; cross-compilation is not supported`);
  if (!(platform === "windows" ? ["x64"] : ["x64", "arm64"]).includes(arch)) {
    throw new Error(`Unsupported architecture: ${platform}/${arch}`);
  }
  const kinds = kind === "all" ? ["cli", "desktop"] : [kind];
  const artifacts = kinds.map(item => platform === "linux"
    ? `luban-${item}_${version}_${arch === "x64" ? "amd64" : arch}.deb`
    : `luban-${item}-${version}-${platform === "windows" ? "win" : "mac"}-${arch}.zip`);
  return { platform, arch, kind, dryRun, artifacts, script: `package-${platform}.mjs`,
    checksums: `SHA256SUMS-${version}-${platform}-${arch}-${kind}.txt` };
}

/** @param {string} directory @param {string[]} artifacts @param {string} filename */
export async function writeChecksums(directory, artifacts, filename) {
  const lines = [];
  for (const name of artifacts) {
    const path = join(directory, name);
    const info = await stat(path);
    if (!info.isFile() || info.size === 0) throw new Error(`Missing or empty artifact: ${name}`);
    const hash = createHash("sha256");
    for await (const chunk of createReadStream(path)) hash.update(chunk);
    lines.push(`${hash.digest("hex")}  ${name}\n`);
  }
  await writeFile(join(directory, filename), lines.join(""));
}

/** @param {string} script @param {string[]} args */
function run(script, args = []) {
  const result = spawnSync(process.execPath, [script, ...args], { cwd: root, stdio: "inherit", shell: false });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`${script} failed (${result.signal || result.status})`);
}

async function main() {
  const pkg = JSON.parse(await readFile(join(root, "package.json"), "utf8"));
  const lock = JSON.parse(await readFile(join(root, "package-lock.json"), "utf8"));
  const plan = releasePlan(process.argv.slice(2), process.platform, process.arch, pkg.version);
  if ("help" in plan) { console.log(help); return; }
  if (lock.version !== pkg.version || lock.packages[""].version !== pkg.version) throw new Error("package.json and package-lock.json versions must match");
  console.log(`Release ${pkg.version}: ${plan.platform}/${plan.arch} (${plan.kind})`);
  console.log([...plan.artifacts, plan.checksums].map(name => `  release/${name}`).join("\n"));
  if (plan.dryRun) return;
  // Electron 44 does not download its runtime during npm ci. CLI-only builds
  // stay independent of Electron; desktop builds ensure its native runtime.
  if (plan.kind !== "cli") run(join(root, "node_modules", "electron", "install.js"));
  run(join(root, "scripts", plan.script), [plan.kind]);
  await writeChecksums(join(root, "release"), plan.artifacts, plan.checksums);
  console.log("Release packages and SHA-256 checksums ready in release/. No upload performed.");
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(error => { console.error(`release: ${error.message}`); process.exitCode = 1; });
}
