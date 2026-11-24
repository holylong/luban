/** Native release packaging entry point. Never commits, tags, or uploads. */
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { readFile, stat, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { ensureElectron } from "./lib/release-network.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
/** @type {Record<string, string>} */
const aliases = { linux: "linux", windows: "windows", win32: "windows", macos: "macos", mac: "macos", darwin: "macos" };
const help = `Usage: npm run release -- [--platform auto|linux|windows|macos] [--kind all|cli|desktop|creator|exe|setup] [--dry-run]

Defaults: current OS, CLI + Desktop + 造物主. Outputs go to release/ with SHA-256 checksums.
Windows builds portable ZIPs plus an Inno Setup Desktop installer (Inno Setup 6 required).
Experimental CLI EXE/setup builds still require explicit --kind exe/setup.
macOS Desktop and 造物主 prefer a .dmg image and fall back to a .zip when hdiutil fails.
Build on the target OS using its native Node architecture; cross-compilation is not supported.
Install dependencies with npm ci first. No git changes, tags, or uploads are performed.
`;

/**
 * @typedef {object} ReleasePlan
 * @property {string} platform
 * @property {string} arch
 * @property {string} kind
 * @property {boolean} dryRun
 * @property {string[]} artifacts Primary artifact name per selected kind
 * @property {(string|null)[]} fallbacks Alternative name when the primary fails
 * @property {string} script
 * @property {string} checksums
 */

/** @param {string[]} args @param {string} host @param {string} arch @param {string} version
 * @returns {{help: true} | ReleasePlan} */
/**
 * Version scheme: MAJOR.MINOR.PATCH where PATCH counts 1-20 per minor and then
 * rolls the minor over. See docs/release.md; a release must never ship 2.2.0 or
 * 2.2.21.
 */
export function versionProblem(version) {
  const match = /^(\d+)\.(\d+)\.(\d+)$/.exec(String(version));
  if (!match) return `version ${version} must look like MAJOR.MINOR.PATCH`;
  const [, major, minor, patch] = match.map(Number);
  if (major < 1) return `version ${version}: major must start at 1`;
  if (patch < 1 || patch > 20) return `version ${version}: patch must be 1-20, then the minor increases (for example 2.2.20 -> 2.3.1)`;
  if (minor < 0) return `version ${version}: minor must be 0 or greater`;
  return null;
}

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
  if (!["all", "cli", "desktop", "creator", "exe", "setup"].includes(kind)) throw new Error("--kind must be all, cli, desktop, creator, exe, or setup");
  if (platform !== aliases[host]) throw new Error(`Build ${platform} on a ${platform} host; cross-compilation is not supported`);
  if (!(platform === "windows" ? ["x64"] : ["x64", "arm64"]).includes(arch)) {
    throw new Error(`Unsupported architecture: ${platform}/${arch}`);
  }
  // The installer wraps the Windows single-file build, so it has no peer elsewhere.
  if (["exe", "setup"].includes(kind) && platform !== "windows") throw new Error("--kind exe/setup is Windows-only; use cli or desktop elsewhere");
  const kinds = kind === "all" ? ["cli", "desktop", "creator"] : [kind];
  /** @typedef {{name: string, fallback: string | null}} Artifact */
  /** @type {Artifact[]} */
  const selected = [];
  for (const item of kinds) {
    if (platform === "linux") {
      selected.push({ name: `luban-${item}_${version}_${arch === "x64" ? "amd64" : arch}.deb`, fallback: null });
    } else if (platform === "windows") {
      if (item === "setup" || item === "exe") {
        selected.push({ name: `luban-${version}-win-${arch}${item === "setup" ? "-setup" : ""}.exe`, fallback: null });
        continue;
      }
      selected.push({ name: `luban-${item}-${version}-win-${arch}.zip`, fallback: null });
      // Every Windows variant ships a per-user setup executable beside its ZIP.
      selected.push({ name: `luban-${item}-${version}-win-${arch}-setup.exe`, fallback: null });

    } else {
      const extension = item === "desktop" || item === "creator" ? "dmg" : "zip";
      const name = `luban-${item}-${version}-mac-${arch}.${extension}`;
      // macOS Desktop is built as a DMG first; package-macos.mjs writes the zip
      // when the image cannot be created, so checksumming follows what exists.
      selected.push({ name, fallback: extension === "dmg" ? name.replace(/\.dmg$/u, ".zip") : null });
    }
  }
  return { platform, arch, kind, dryRun, artifacts: selected.map(entry => entry.name),
    fallbacks: selected.map(entry => entry.fallback), script: `package-${platform}.mjs`,
    checksums: `SHA256SUMS-${version}-${platform}-${arch}-${kind}.txt` };
}

/** Identity of an existing nonempty artifact, used to reject files left behind
 * by an earlier run in release/. @param {string} directory @param {string} name */
export async function artifactSignature(directory, name) {
  const info = await stat(join(directory, name)).catch(() => null);
  return info?.isFile() && info.size > 0 ? `${info.size}:${info.mtimeMs}` : null;
}

/** Pick the artifact each kind actually produced, preferring the primary name
 * and accepting its declared fallback. @param {string} directory
 * @param {string[]} artifacts @param {(string|null)[]} fallbacks
 * @param {Map<string, string|null>} before */
export async function resolveArtifacts(directory, artifacts, fallbacks = [], before = new Map()) {
  const produced = [];
  for (let index = 0; index < artifacts.length; index++) {
    /** @type {string[]} */
    const candidates = [artifacts[index]];
    const fallback = fallbacks[index];
    if (fallback) candidates.push(fallback);
    let found;
    for (const name of candidates) {
      const signature = await artifactSignature(directory, name);
      if (signature && signature !== (before.get(name) ?? null)) { found = name; break; }
    }
    if (!found) throw new Error(`No fresh package in release/: expected one of ${candidates.join(", ")}`);
    produced.push(found);
  }
  return produced;
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
  const versionError = versionProblem(pkg.version);
  if (versionError) throw new Error(versionError);
  console.log(`Release ${pkg.version}: ${plan.platform}/${plan.arch} (${plan.kind})`);
  console.log([...plan.artifacts, plan.checksums].map(name => `  release/${name}`).join("\n"));
  if (plan.dryRun) return;
  // Electron 44 does not download its runtime during npm ci. CLI-only and
  // installer-only builds stay independent of Electron; desktop builds ensure
  // its native runtime.
  if (plan.platform !== "windows" && ["all", "desktop", "creator"].includes(plan.kind)) await ensureElectron(root);
  const directory = join(root, "release");
  /** @type {Map<string, string|null>} */
  const before = new Map();
  for (const name of plan.artifacts) before.set(name, await artifactSignature(directory, name));
  for (const name of plan.fallbacks) if (name) before.set(name, await artifactSignature(directory, name));
  run(join(root, "scripts", plan.script), [plan.kind]);
  // A DMG failure inside package-macos.mjs leaves only the zip, which the
  // checksums must describe instead of the planned image.
  const produced = await resolveArtifacts(directory, plan.artifacts, plan.fallbacks, before);
  await writeChecksums(directory, produced, plan.checksums);
  console.log(`Checksummed: ${produced.map(name => `release/${name}`).join(", ")}`);
  console.log("Release packages and SHA-256 checksums ready in release/. No upload performed.");
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(error => { console.error(`release: ${error.message}`); process.exitCode = 1; });
}
