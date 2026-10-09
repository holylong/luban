/** Build self-contained Windows x64 CLI and Desktop zip packages. */
import rcedit from "rcedit";
import { spawnSync } from "node:child_process";
import { copyFileSync, cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const version = JSON.parse(readFileSync(join(root, "package.json"), "utf8")).version;
const selection = process.argv[2] || "all";
if (process.platform !== "win32" || process.arch !== "x64") {
  throw new Error("package:windows requires Windows x64");
}
if (!["all", "cli", "desktop"].includes(selection)) throw new Error("choose all, cli, or desktop");

function run(label, command, args, cwd = root, capture = false) {
  process.stdout.write(`\n> ${label}\n`);
  const result = spawnSync(command, args, {
    cwd,
    stdio: capture ? ["ignore", "pipe", "pipe"] : "inherit",
    shell: false,
    windowsHide: true,
  });
  if (capture) {
    if (result.stdout?.length) process.stdout.write(result.stdout);
    if (result.stderr?.length) process.stderr.write(result.stderr);
  }
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`${label} failed (${result.status})`);
}

function npmCli() {
  const candidate = resolve(dirname(process.execPath), "node_modules", "npm", "bin", "npm-cli.js");
  if (!existsSync(candidate)) throw new Error(`npm CLI not found at ${candidate}`);
  return candidate;
}

function copyRuntime(payload, kind) {
  const app = join(payload, "app");
  mkdirSync(app, { recursive: true });
  cpSync(join(root, "dist"), join(app, "dist"), { recursive: true });
  cpSync(join(root, "plugins"), join(app, "plugins"), { recursive: true });
  for (const name of ["package.json", "package-lock.json", "README.md"]) {
    copyFileSync(join(root, name), join(app, name));
  }
  run(`Install ${kind} runtime dependencies`, process.execPath, [npmCli(), "ci", "--omit=dev", "--ignore-scripts", "--no-audit", "--no-fund"], app);
  copyFileSync(process.execPath, join(payload, "node.exe"));
  const nodeLicense = resolve(dirname(process.execPath), "LICENSE");
  if (existsSync(nodeLicense)) copyFileSync(nodeLicense, join(payload, "NODE-LICENSE"));
  run(`Smoke test ${kind} runtime`, join(payload, "node.exe"), [join(app, "dist", "cli.js"), "--version"], payload, true);
}

async function packageVariant(kind) {
  const output = join(root, "release");
  const stageRoot = join(output, ".stage");
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
  if (kind === "desktop") {
    const electronSource = join(root, "node_modules", "electron", "dist");
    if (!existsSync(join(electronSource, "electron.exe"))) {
      throw new Error("Electron runtime missing; run npm ci before package:windows:desktop");
    }
    cpSync(electronSource, join(payload, "electron"), { recursive: true });
    await rcedit(join(payload, "electron", "electron.exe"), {
      icon: join(payload, "luban.ico"),
      "version-string": { ProductName: "luban Desktop", FileDescription: "luban Desktop" },
      "product-version": version,
    });
    cpSync(join(root, "apps", "desktop"), join(payload, "desktop"), { recursive: true });
    copyFileSync(join(root, "packaging", "windows", "luban-desktop.cmd"), join(payload, "luban-desktop.cmd"));
  }
  writeFileSync(join(payload, "README.txt"), [
    `luban ${version} Windows x64 ${kind}`,
    "",
    kind === "cli"
      ? "Run luban.cmd from this folder, or add this folder to PATH."
      : "Run luban-desktop.cmd to open the graphical workspace. luban.cmd is also included.",
    "Run create-shortcuts.cmd to create desktop shortcuts with the luban icon.",
    "Node.js is bundled. Configuration is read from %USERPROFILE%\\.luban\\config.json.",
    "",
  ].join("\r\n"));
  mkdirSync(output, { recursive: true });
  const zip = join(output, `${folder}.zip`);
  rmSync(zip, { force: true });
  run(`Zip ${kind} package`, "tar.exe", ["-a", "-c", "-f", zip, "-C", stageRoot, folder]);
  process.stdout.write(`\nPackage: ${zip}\n`);
}

run("Build luban", process.execPath, [join(root, "scripts", "build.mjs")]);
if (selection === "all" || selection === "cli") await packageVariant("cli");
if (selection === "all" || selection === "desktop") await packageVariant("desktop");
