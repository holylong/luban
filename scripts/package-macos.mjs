/** Build self-contained macOS CLI, Desktop and 造物主 packages: the two apps
 * prefer a DMG image and fall back to a zip when the image cannot be created. */
import { spawnSync } from "node:child_process";
import {
  chmodSync, copyFileSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, statSync,
  symlinkSync, writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { patchInk } from "./patch-ink.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const version = JSON.parse(readFileSync(join(root, "package.json"), "utf8")).version;
const architecture = { x64: "x64", arm64: "arm64" }[process.arch];
const selection = process.argv[2] || "all";
if (process.platform !== "darwin" || !architecture) throw new Error("package:macos requires macOS x64 or arm64");
if (!["all", "cli", "desktop", "creator"].includes(selection)) throw new Error("choose all, cli, desktop, or creator");

const APP_NAME = "luban";

/** Electron bundles share the bundled Node runtime and CLI but keep their own
 * entry point, so luban.app and Luban Creator.app install side by side. */
/** @typedef {{bundle: string, display: string, identifier: string, entry: string, title: string}} AppSpec */
/** @type {Record<string, AppSpec>} */
const APP_SPECS = {
  desktop: { bundle: APP_NAME, display: APP_NAME, identifier: "com.luban.desktop", entry: "desktop", title: "luban" },
  creator: { bundle: "Luban Creator", display: "造物主", identifier: "com.luban.creator", entry: "creator", title: "造物主" },
};

function run(label, command, args, cwd = root, capture = false) {
  process.stdout.write(`\n> ${label}\n`);
  const result = spawnSync(command, args, { cwd, stdio: capture ? ["ignore", "pipe", "pipe"] : "inherit", shell: false });
  if (capture) {
    if (result.stdout?.length) process.stdout.write(result.stdout);
    if (result.stderr?.length) process.stderr.write(result.stderr);
  }
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`${label} failed (${result.status})`);
}

function npmCli() {
  // Windows ships npm beside node.exe; the macOS tarball keeps it in ../lib.
  const candidates = [
    resolve(dirname(process.execPath), "node_modules", "npm", "bin", "npm-cli.js"),
    resolve(dirname(process.execPath), "..", "lib", "node_modules", "npm", "bin", "npm-cli.js"),
  ];
  const found = candidates.find(candidate => existsSync(candidate));
  if (!found) throw new Error(`npm CLI not found; looked in ${candidates.join(", ")}`);
  return found;
}

const nodeLicense = [resolve(dirname(process.execPath), "..", "LICENSE"), resolve(dirname(process.execPath), "LICENSE")]
  .find(candidate => existsSync(candidate));

function copyRuntime(payload, kind) {
  const app = join(payload, "app");
  mkdirSync(app, { recursive: true });
  cpSync(join(root, "dist"), join(app, "dist"), { recursive: true });
  cpSync(join(root, "plugins"), join(app, "plugins"), { recursive: true });
  mkdirSync(join(app, "scripts", "lib"), { recursive: true });
  copyFileSync(join(root, "scripts", "patch-ink.mjs"), join(app, "scripts", "patch-ink.mjs"));
  copyFileSync(join(root, "scripts", "lib", "ink-text-cache.mjs"), join(app, "scripts", "lib", "ink-text-cache.mjs"));
  for (const name of ["package.json", "package-lock.json", "README.md"]) {
    copyFileSync(join(root, name), join(app, name));
  }
  run(`Install ${kind} runtime dependencies`, process.execPath, [npmCli(), "ci", "--omit=dev", "--ignore-scripts", "--no-audit", "--no-fund"], app);
  patchInk(app);
  copyFileSync(process.execPath, join(payload, "node"));
  chmodSync(join(payload, "node"), 0o755);
  if (nodeLicense) copyFileSync(nodeLicense, join(payload, "NODE-LICENSE"));
  run(`Smoke test ${kind} runtime`, join(payload, "node"), [join(app, "dist", "cli.js"), "--version"], payload, true);
}

function makeIcon(resources) {
  // luban-app-1024.png is the pre-rounded, transparent-margin icon macOS expects;
  // the square luban-512.png stays for tray, window and web use.
  const rounded = join(root, "assets", "luban-app-1024.png");
  const source = existsSync(rounded) ? rounded : join(root, "assets", "luban-512.png");
  if (!existsSync(source)) return false;
  const work = mkdtempSync(join(tmpdir(), "luban-icns-"));
  const iconset = join(work, "AppIcon.iconset");
  mkdirSync(iconset);
  try {
    for (const size of [16, 32, 128, 256, 512]) {
      for (const scale of [1, 2]) {
        const pixels = size * scale;
        const name = `icon_${size}x${size}${scale === 2 ? "@2x" : ""}.png`;
        run(`Icon ${pixels}px`, "sips", ["-z", String(pixels), String(pixels), source, "--out", join(iconset, name)], root, true);
      }
    }
    const icns = join(work, "AppIcon.icns");
    run("Assemble AppIcon.icns", "iconutil", ["-c", "icns", iconset, "-o", icns], root, true);
    copyFileSync(icns, join(resources, "AppIcon.icns"));
    return true;
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}

function plistSet(plist, key, value) {
  const set = spawnSync("/usr/libexec/PlistBuddy", ["-c", `Set :${key} ${value}`, plist], { stdio: "pipe" });
  if (set.status === 0) return;
  run(`Set ${key}`, "/usr/libexec/PlistBuddy", ["-c", `Add :${key} string ${value}`, plist]);
}

/** Move without copying when both paths share a volume. @param {string} from @param {string} to */
function movePath(from, to) {
  try { renameSync(from, to); }
  catch {
    cpSync(from, to, { recursive: true, verbatimSymlinks: true });
    rmSync(from, { recursive: true, force: true });
  }
}

/** Desktop bundle: Electron runtime, the Electron entry in Resources/app, and the
 * bundled Node runtime plus CLI in Resources/node and Resources/luban. Nothing
 * lives outside the .app, so dragging it to /Applications keeps working. */
function buildApp(payload, kind = "desktop") {
  const spec = APP_SPECS[kind];
  if (!spec) throw new Error(`unknown app kind: ${kind}`);
  const source = join(root, "node_modules", "electron", "dist", "Electron.app");
  if (!existsSync(source)) throw new Error(`Electron runtime missing before package:macos:${kind}`);
  const bundle = join(payload, `${spec.bundle}.app`);
  cpSync(source, bundle, { recursive: true, verbatimSymlinks: true });
  const contents = join(bundle, "Contents");
  const resources = join(contents, "Resources");
  const plist = join(contents, "Info.plist");
  plistSet(plist, "CFBundleName", spec.bundle);
  plistSet(plist, "CFBundleDisplayName", spec.display);
  plistSet(plist, "CFBundleIdentifier", spec.identifier);
  plistSet(plist, "CFBundleShortVersionString", version);
  plistSet(plist, "CFBundleVersion", version);
  if (makeIcon(resources)) plistSet(plist, "CFBundleIconFile", "AppIcon");
  // Electron loads Contents/Resources/app, so the CLI runtime moves beside it.
  movePath(join(payload, "node"), join(resources, "node"));
  movePath(join(payload, "app"), join(resources, "luban"));
  const appDir = join(resources, "app");
  mkdirSync(appDir, { recursive: true });
  cpSync(join(root, "apps", spec.entry), join(appDir, spec.entry), { recursive: true });
  writeFileSync(join(appDir, "package.json"), `${JSON.stringify({ name: `luban-${kind}`, private: true, main: "main.cjs" }, null, 2)}\n`);
  writeFileSync(join(appDir, "main.cjs"), [
    "// Electron entry point: hand the bundled Node runtime and CLI to luban.",
    'const { app } = require("electron");',
    'const { join, resolve } = require("node:path");',
    "// <bundle>/Contents/Resources/app -> <bundle>/Contents/Resources",
    'const root = resolve(app.getAppPath(), "..");',
    "process.env.LUBAN_NODE_BIN ||= join(root, \"node\");",
    "process.env.LUBAN_CLI ||= join(root, \"luban\", \"dist\", \"cli.js\");",
    `require(join(app.getAppPath(), "${spec.entry}", "main.cjs"));`,
    "",
  ].join("\n"));
  // Replacing Resources invalidates Electron's signature; arm64 refuses unsigned
  // code, so re-sign the bundle ad hoc.
  run("Sign app bundle (ad hoc)", "codesign", ["--force", "--deep", "--sign", "-", bundle], root, true);
}

function writeReadme(payload, kind) {
  const spec = APP_SPECS[kind];
  const bundle = spec ? `${spec.bundle}.app` : `${APP_NAME}.app`;
  writeFileSync(join(payload, "README.txt"), [
    `luban ${version} macOS ${architecture} ${kind}`,
    "",
    kind === "cli"
      ? "Run ./luban from this folder, or add this folder to PATH."
      : kind === "creator"
        ? `Drag "${bundle}" to /Applications (it also runs in place), then look for 造物主 in the menu bar. ./luban is the CLI the queue workers run.`
        : "Drag \"luban.app\" to /Applications (it also runs in place), or start it with ./luband (./luban-desktop is also supported). ./luban is the CLI. Add this folder to PATH to use luban and luband anywhere.",
    ...(spec ? [`The app carries its own Node.js runtime and CLI, so moving "${bundle}" elsewhere keeps working.`] : []),
    "Node.js is bundled; no local Node.js installation is required.",
    "Configuration is read from ~/.luban/config.json.",
    "These builds are signed ad hoc, so Gatekeeper may refuse the first launch:",
    `  xattr -dr com.apple.quarantine "${kind === "cli" ? "." : bundle}"`,
    "",
  ].join("\n"));
}

/** @param {string} payload @param {string} output @param {string} folder @param {string} kind */
function zipPackage(payload, output, folder, kind) {
  const zip = join(output, `${folder}.zip`);
  rmSync(zip, { force: true });
  run(`Zip ${kind} package`, "ditto", ["-c", "-k", "--sequesterRsrc", "--keepParent", payload, zip]);
  process.stdout.write(`\nPackage: ${zip}\n`);
  return zip;
}

/** @param {string} source @param {string} output @param {string} folder @param {string} volumeName
 * @returns {string|null} The image path, or null so the caller can fall back. */
function dmgPackage(source, output, folder, volumeName) {
  const dmg = join(output, `${folder}.dmg`);
  rmSync(dmg, { force: true });
  try {
    run("Create DMG (hdiutil)", "hdiutil", [
      "create", "-volname", volumeName, "-srcfolder", source, "-ov", "-format", "UDZO", "-quiet", dmg,
    ]);
    const info = statSync(dmg);
    if (!info.isFile() || info.size === 0) throw new Error("hdiutil produced no image");
    process.stdout.write(`\nPackage: ${dmg}\n`);
    return dmg;
  } catch (error) {
    rmSync(dmg, { force: true });
    process.stderr.write(`\nDMG creation failed (${error.message}); writing a zip instead.\n`);
    return null;
  }
}

/** Drag-to-Applications volume: the self-contained app plus the usual alias.
 * The bundle is moved, not copied, so the image does not double disk use. */
function stageDmg(payload, stageRoot, bundleName = `${APP_NAME}.app`) {
  const dir = join(stageRoot, "dmg");
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  movePath(join(payload, bundleName), join(dir, bundleName));
  symlinkSync("/Applications", join(dir, "Applications"));
  return dir;
}

function packageVariant(kind) {
  const output = join(root, "release");
  const stageRoot = join(output, ".stage");
  const folder = `luban-${kind}-${version}-mac-${architecture}`;
  const payload = join(stageRoot, folder);
  rmSync(payload, { recursive: true, force: true });
  mkdirSync(payload, { recursive: true });
  copyRuntime(payload, kind);
  copyFileSync(join(root, "packaging", "macos", "luban"), join(payload, "luban"));
  chmodSync(join(payload, "luban"), 0o755);
  if (kind === "desktop" || kind === "creator") buildApp(payload, kind);
  if (kind === "desktop") {
    for (const name of ["luband", "luban-desktop"]) {
      copyFileSync(join(root, "packaging", "macos", "luban-desktop"), join(payload, name));
      chmodSync(join(payload, name), 0o755);
    }
  }
  writeReadme(payload, kind);
  mkdirSync(output, { recursive: true });
  // Both apps ship as drag-to-Applications DMGs; if an image cannot be created
  // the same folder is zipped instead. A CLI folder is always a zip.
  if (kind === "desktop" || kind === "creator") {
    const app = APP_SPECS[kind];
    const bundleName = `${app.bundle}.app`;
    const volume = stageDmg(payload, stageRoot, bundleName);
    if (dmgPackage(volume, output, folder, `${app.title} ${version}`)) return;
    movePath(join(volume, bundleName), join(payload, bundleName));
    rmSync(volume, { recursive: true, force: true });
  }
  zipPackage(payload, output, folder, kind);
}

run("Build luban", process.execPath, [join(root, "scripts", "build.mjs")]);
if (selection === "all" || selection === "cli") packageVariant("cli");
if (selection === "all" || selection === "desktop") packageVariant("desktop");
if (selection === "all" || selection === "creator") packageVariant("creator");
