/** Build self-contained Windows x64 CLI/Desktop zips, a single-file luban.exe,
 * and a 7-Zip self-extracting installer. */
import rcedit from "rcedit";
import { spawnSync } from "node:child_process";
import { copyFileSync, cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { patchInk } from "./patch-ink.mjs";
import { ensureElectron, installRuntime } from "./lib/release-network.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const version = JSON.parse(readFileSync(join(root, "package.json"), "utf8")).version;
const selection = process.argv[2] || "all";
if (process.platform !== "win32" || process.arch !== "x64") {
  throw new Error("package:windows requires Windows x64");
}
if (!["all", "cli", "desktop", "creator", "exe", "setup"].includes(selection)) throw new Error("choose all, cli, desktop, creator, exe, or setup");
if (["exe", "setup"].includes(selection) && Number(process.versions.node.split(".")[0]) < 25) {
  throw new Error("Experimental EXE builds require Node.js >=25. Use npm run release for ZIP packages instead.");
}

const releaseDir = join(root, "release");
const stageRoot = join(releaseDir, ".stage");
const seaDir = join(stageRoot, `sea-${version}`);
const singleExe = join(releaseDir, `luban-${version}-win-x64.exe`);
const installer = join(releaseDir, `luban-${version}-win-x64-setup.exe`);
const SEVEN_ZIP = [
  process.env.LUBAN_7Z,
  join(process.env.ProgramFiles || "C:\\Program Files", "7-Zip", "7z.exe"),
  join(process.env["ProgramFiles(x86)"] || "C:\\Program Files (x86)", "7-Zip", "7z.exe"),
].filter(Boolean);
/** `--build-sea` (Node >= 25.5) writes the executable in one step; older
 * releases only dump a preparation blob for postject to inject. */
const NODE_MAJOR = Number(process.versions.node.split(".")[0]);
const NODE_MINOR = Number(process.versions.node.split(".")[1] ?? 0);
const BUILD_SEA = NODE_MAJOR > 25 || (NODE_MAJOR === 25 && NODE_MINOR >= 5);

/** @param {string} label @param {string} command @param {string[]} args
 * @param {string} cwd @param {boolean} capture @param {"inherit"|"ignore"} stdin */
function run(label, command, args, cwd = root, capture = false, stdin = "inherit") {
  process.stdout.write(`\n> ${label}\n`);
  const result = spawnSync(command, args, {
    cwd,
    stdio: capture ? ["ignore", "pipe", "pipe"] : [stdin, "inherit", "inherit"],
    shell: false,
    windowsHide: true,
  });
  if (capture) {
    if (result.stdout?.length) process.stdout.write(result.stdout);
    if (result.stderr?.length) process.stderr.write(result.stderr);
  }
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`${label} failed (${result.status})`);
  return result;
}

function npmCli() {
  const candidate = resolve(dirname(process.execPath), "node_modules", "npm", "bin", "npm-cli.js");
  if (!existsSync(candidate)) throw new Error(`npm CLI not found at ${candidate}`);
  return candidate;
}

/** 7-Zip is the only external tool the installer needs; it ships with the
 * windows-2022 runner and most developer machines. */
function sevenZip() {
  const found = SEVEN_ZIP.find(candidate => existsSync(candidate));
  if (!found) throw new Error("7-Zip not found; install 7-Zip or set LUBAN_7Z to 7z.exe");
  return found;
}

/** Drop the Authenticode certificate table so the patched Node binary is not
 * rejected for carrying a stale signature after the SEA blob is injected. */
function stripAuthenticode(file) {
  const image = readFileSync(file);
  const peOffset = image.readUInt32LE(0x3c);
  if (image.readUInt32LE(peOffset) !== 0x00004550) throw new Error(`${file} is not a PE image`);
  const optional = peOffset + 24;
  const magic = image.readUInt16LE(optional);
  // The certificate table is data directory 4, right after eight directories.
  const certificate = optional + (magic === 0x20b ? 112 : 96) + 4 * 8;
  if (image.readUInt32LE(certificate + 4) === 0) return;
  const sections = image.readUInt16LE(peOffset + 6);
  const sectionTable = optional + image.readUInt16LE(peOffset + 20);
  let end = 0;
  for (let index = 0; index < sections; index++) {
    const entry = sectionTable + index * 40;
    end = Math.max(end, image.readUInt32LE(entry + 20) + image.readUInt32LE(entry + 16));
  }
  image.writeUInt32LE(0, certificate);
  image.writeUInt32LE(0, certificate + 4);
  writeFileSync(file, end > 0 && end < image.length ? image.subarray(0, end) : image);
}

/** ink and yoga-layout rely on top-level await, so the bundle stays ESM; the
 * banner restores the CommonJS `require` the bundled CJS dependencies call. */
function seaPlugins() {
  return [{
    name: "sea-interop",
    setup(build) {
      build.onResolve({ filter: /^react-devtools-core$/ }, () => ({ path: "react-devtools-core", namespace: "devtools-stub" }));
      build.onLoad({ filter: /.*/, namespace: "devtools-stub" }, () => ({
        contents: "export default { initialize() {}, connectToDevTools() {} };",
        loader: "js",
      }));
      // A SEA has no package.json on disk, so the version is baked in.
      build.onLoad({ filter: /[\\/]version\.js$/ }, args => args.path.endsWith(join("dist", "version.js"))
        ? { contents: `export const VERSION = ${JSON.stringify(version)};`, loader: "js" }
        : null);
    },
  }];
}

/** Compile dist/cli.js into one ESM file, then inject it into a copy of node.exe. */
async function buildSingleExe() {
  rmSync(seaDir, { recursive: true, force: true });
  mkdirSync(seaDir, { recursive: true });
  const esbuild = await import("esbuild");
  const bundle = join(seaDir, "luban.mjs");
  await esbuild.build({
    entryPoints: [join(root, "dist", "cli.js")],
    bundle: true,
    platform: "node",
    format: "esm",
    target: "node20",
    outfile: bundle,
    logLevel: "warning",
    banner: { js: "import { createRequire as __createRequire } from \"node:module\"; const require = __createRequire(import.meta.url);" },
    plugins: seaPlugins(),
  });
  const exe = join(seaDir, "luban.exe");
  const config = join(seaDir, "sea-config.json");
  // ink keeps top-level await, so the injected main script is an ES module.
  const seaConfig = { main: bundle, mainFormat: "module", disableExperimentalSEAWarning: true };
  // LUBAN_SEA_MODE=blob forces the postject path so the fallback stays testable.
  if (BUILD_SEA && process.env.LUBAN_SEA_MODE !== "blob") {
    // One step: Node copies its own binary and injects the blob itself.
    writeFileSync(config, JSON.stringify({ ...seaConfig, output: exe }, null, 2));
    run("Build single-file exe", process.execPath, ["--build-sea", config]);
  } else {
    // Node 24 through 25.4 accept an ESM main but still need postject.
    if (NODE_MAJOR < 24) throw new Error("Building luban.exe needs Node.js 24 or newer for ESM single executables");
    const blob = join(seaDir, "sea-prep.blob");
    writeFileSync(config, JSON.stringify({ ...seaConfig, output: blob }, null, 2));
    run("Prepare SEA blob", process.execPath, ["--experimental-sea-config", config]);
    const postject = join(root, "node_modules", "postject", "dist", "cli.js");
    if (!existsSync(postject)) throw new Error("postject is missing; run npm ci before building the Windows exe");
    copyFileSync(process.execPath, exe);
    stripAuthenticode(exe);
    run("Inject SEA blob", process.execPath, [postject, exe, "NODE_SEA_BLOB", blob,
      "--sentinel-fuse", "NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2"]);
  }
  const smoke = run("Smoke test single-file exe", exe, ["--version"], seaDir, true);
  const printed = String(smoke.stdout ?? "").trim();
  if (printed !== version) throw new Error(`luban.exe reported "${printed}", expected ${version}`);
  process.stdout.write(`single-file exe: ${exe} (${printed})\n`);
  return exe;
}

/** Text assets have to keep CRLF and the package version token. */
function payloadFile(source, token = "__LUBAN_VERSION__") {
  return readFileSync(join(root, "packaging", "windows", source), "utf8")
    .split(token).join(version)
    .replace(/\r?\n/gu, "\r\n");
}

async function packageSingleExe() {
  const exe = await buildSingleExe();
  rmSync(singleExe, { force: true });
  copyFileSync(exe, singleExe);
  process.stdout.write(`\nPackage: ${singleExe}\n`);
}

/** Single-file exe plus its asset tree, wrapped in a 7-Zip SFX installer. */
async function packageSetup() {
  const exe = await buildSingleExe();
  const staging = join(seaDir, "installer");
  const payload = join(staging, "luban");
  rmSync(staging, { recursive: true, force: true });
  mkdirSync(payload, { recursive: true });
  copyFileSync(exe, join(payload, "luban.exe"));
  cpSync(join(root, "dist", "assets"), join(payload, "assets"), { recursive: true });
  cpSync(join(root, "dist", "web-ui"), join(payload, "web-ui"), { recursive: true });
  if (existsSync(join(root, "plugins"))) cpSync(join(root, "plugins"), join(payload, "plugins"), { recursive: true });
  copyFileSync(join(root, "assets", "luban.ico"), join(payload, "luban.ico"));
  writeFileSync(join(payload, "install.ps1"), payloadFile("install.ps1"));
  writeFileSync(join(payload, "uninstall.cmd"), payloadFile("uninstall.cmd"));
  writeFileSync(join(payload, "uninstall.ps1"), payloadFile("uninstall.ps1"));
  writeFileSync(join(payload, "README.txt"), [
    `luban ${version} Windows x64`,
    "",
    "luban.exe is a single-file build: run it in a terminal for the TUI.",
    "Or run luban.cmd to keep the terminal window open while it works.",
    "Run create-shortcuts.cmd to create a desktop shortcut.",
    "Uninstall with uninstall.cmd in this folder (it also removes the PATH entry).",
    "Configuration is read from %USERPROFILE%\\.luban\\config.json.",
    "",
  ].join("\r\n"));
  writeFileSync(join(payload, "luban.cmd"), [
    "@echo off",
    "setlocal",
    "set \"ROOT=%~dp0\"",
    "\"%ROOT%luban.exe\" %*",
    "",
  ].join("\r\n"));
  writeFileSync(join(payload, "create-shortcuts.cmd"), payloadFile("create-shortcuts-setup.cmd"));
  writeFileSync(join(payload, "create-shortcuts.ps1"), payloadFile("create-shortcuts-setup.ps1"));
  writeFileSync(join(staging, "install.cmd"), payloadFile("install.cmd"));

  const archive = join(seaDir, "payload.7z");
  rmSync(archive, { force: true });
  run("Archive installer payload", sevenZip(), ["a", "-t7z", "-mx=7", archive, ".\\*", "-bso0", "-bsp0"], staging);
  const sfxModule = join(dirname(sevenZip()), "7z.sfx");
  if (!existsSync(sfxModule)) throw new Error(`7z.sfx not found at ${sfxModule}; reinstall 7-Zip`);
  const config = [
    ";!@Install@!UTF-8!",
    `Title=luban ${version}`,
    `BeginPrompt=Install luban ${version} for the current user?`,
    "Progress=\"yes\"",
    "RunProgram=\"install.cmd\"",
    ";!@InstallEnd@!",
    "",
  ].join("\r\n");
  rmSync(installer, { force: true });
  writeFileSync(installer, Buffer.concat([readFileSync(sfxModule), Buffer.from(config, "utf8"), readFileSync(archive)]));
  const header = readFileSync(installer).subarray(0, 2).toString("latin1");
  if (header !== "MZ") throw new Error(`installer is not an executable: ${installer}`);
  process.stdout.write(`\nPackage: ${installer}\n`);
}

function copyRuntime(payload, kind) {
  const app = join(payload, "app");
  mkdirSync(app, { recursive: true });
  cpSync(join(root, "dist"), join(app, "dist"), { recursive: true });
  if (existsSync(join(root, "plugins"))) cpSync(join(root, "plugins"), join(app, "plugins"), { recursive: true });
  mkdirSync(join(app, "scripts", "lib"), { recursive: true });
  copyFileSync(join(root, "scripts", "patch-ink.mjs"), join(app, "scripts", "patch-ink.mjs"));
  copyFileSync(join(root, "scripts", "lib", "ink-text-cache.mjs"), join(app, "scripts", "lib", "ink-text-cache.mjs"));
  for (const name of ["package.json", "package-lock.json", "README.md"]) {
    copyFileSync(join(root, name), join(app, name));
  }
  if (existsSync(join(root, ".npmrc"))) copyFileSync(join(root, ".npmrc"), join(app, ".npmrc"));
  installRuntime(root, app, npmCli());
  patchInk(app);
  copyFileSync(process.execPath, join(payload, "node.exe"));
  const nodeLicense = resolve(dirname(process.execPath), "LICENSE");
  if (existsSync(nodeLicense)) copyFileSync(nodeLicense, join(payload, "NODE-LICENSE"));
  run(`Smoke test ${kind} runtime`, join(payload, "node.exe"), [join(app, "dist", "cli.js"), "--version"], payload, true);
}

/** @param {"cli" | "desktop" | "creator"} kind */
async function packageVariant(kind) {
  if (kind === "creator" && !existsSync(join(root, "dist", "web-ui", "creator.html"))) {
    throw new Error("Creator web UI missing; install the dev dependencies and rebuild");
  }
  const folder = `luban-${kind}-${version}-win-x64`;
  const payload = join(stageRoot, folder);
  rmSync(payload, { recursive: true, force: true });
  mkdirSync(payload, { recursive: true });
  copyRuntime(payload, kind);
  copyFileSync(join(root, "assets", "luban.ico"), join(payload, "luban.ico"));
  for (const name of ["create-shortcuts.cmd", "create-shortcuts.ps1"]) {
    copyFileSync(join(root, "packaging", "windows", name), join(payload, name));
  }
  copyFileSync(join(root, "packaging", "windows", "luban.cmd"), join(payload, "luban.cmd"));
  if (kind !== "cli") {
    const electronSource = join(root, "node_modules", "electron", "dist");
    if (!existsSync(join(electronSource, "electron.exe"))) {
      throw new Error(`Electron runtime missing before package:windows:${kind}`);
    }
    cpSync(electronSource, join(payload, "electron"), { recursive: true });
    await rcedit(join(payload, "electron", "electron.exe"), {
      icon: join(payload, "luban.ico"),
      "version-string": kind === "creator"
        ? { ProductName: "Creator", FileDescription: "luban Creator task queue" }
        : { ProductName: "luban", FileDescription: "luban desktop workspace" },
      "product-version": version,
    });
    cpSync(join(root, "apps", kind), join(payload, kind), { recursive: true });
    for (const name of kind === "desktop" ? ["luband.cmd", "luban-desktop.cmd"] : ["luban-creator.cmd"]) {
      copyFileSync(join(root, "packaging", "windows", `luban-${kind}.cmd`), join(payload, name));
    }
  }
  writeFileSync(join(payload, "README.txt"), [
    `luban ${version} Windows x64 ${kind}`,
    "",
    {
      cli: "Run luban.cmd from this folder, or add this folder to PATH.",
      desktop: "Run luband.cmd to open the graphical workspace (luban-desktop.cmd is also supported). luban.cmd is the CLI. Add this folder to PATH to use luban and luband anywhere.",
      creator: "Run luban-creator.cmd to open Creator. It stays in the notification area when closed. luban.cmd is the CLI.",
    }[kind],
    "Run create-shortcuts.cmd to create desktop shortcuts with the luban icon.",
    "Node.js is bundled. Configuration is read from %USERPROFILE%\\.luban\\config.json.",
    "",
  ].join("\r\n"));
  mkdirSync(releaseDir, { recursive: true });
  const zip = join(releaseDir, `${folder}.zip`);
  rmSync(zip, { force: true });
  run(`Zip ${kind} package`, "tar.exe", ["-a", "-c", "-f", zip, "-C", stageRoot, folder]);
  process.stdout.write(`\nPackage: ${zip}\n`);
}

run("Build luban", process.execPath, [join(root, "scripts", "build.mjs")]);
if (["all", "desktop", "creator"].includes(selection)) await ensureElectron(root);
if (selection === "all" || selection === "cli") await packageVariant("cli");
if (selection === "all" || selection === "desktop") await packageVariant("desktop");
if (selection === "all" || selection === "creator") await packageVariant("creator");
if (selection === "exe") await packageSingleExe();
if (selection === "setup") await packageSetup();
