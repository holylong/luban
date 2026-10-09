/** Build separately named, self-contained Linux CLI and Desktop installers. */
import { spawnSync } from "node:child_process";
import { chmodSync, copyFileSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const version = JSON.parse(readFileSync(join(root, "package.json"), "utf8")).version;
const architecture = { x64: "amd64", arm64: "arm64" }[process.arch];
const selection = process.argv[2] || "all";
if (process.platform !== "linux" || !architecture) throw new Error("package:linux requires Linux x64 or arm64");
if (!["all", "cli", "desktop"].includes(selection)) throw new Error("choose all, cli, or desktop");

function run(label, command, args, cwd) {
  process.stdout.write(`\n> ${label}\n`);
  const result = spawnSync(command, args, { cwd, stdio: "inherit", shell: false });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`${label} failed (${result.status})`);
}

const nodeLicense = [resolve(dirname(process.execPath), "..", "LICENSE"), "/usr/share/doc/nodejs/copyright"]
  .find(candidate => existsSync(candidate));
if (!nodeLicense) throw new Error("Node.js license not found beside node or in /usr/share/doc/nodejs");

function packageVariant(kind) {
  const packageName = `luban-${kind}`;
  const stage = mkdtempSync(join(tmpdir(), `${packageName}-deb-`));
  const payload = join(stage, "opt", packageName);
  const app = join(payload, "app");
  const bin = join(stage, "usr", "bin");
  try {
    mkdirSync(app, { recursive: true });
    mkdirSync(bin, { recursive: true });
    cpSync(join(root, "dist"), join(app, "dist"), { recursive: true });
    cpSync(join(root, "plugins"), join(app, "plugins"), { recursive: true });
    for (const name of ["package.json", "package-lock.json", "README.md"]) copyFileSync(join(root, name), join(app, name));
    run(`Install ${kind} runtime dependencies`, "npm", ["ci", "--omit=dev", "--ignore-scripts", "--no-audit", "--no-fund"], app);
    copyFileSync(process.execPath, join(payload, "node"));
    chmodSync(join(payload, "node"), 0o755);
    copyFileSync(nodeLicense, join(payload, "NODE-LICENSE"));
    run(`Smoke test ${kind} runtime`, join(payload, "node"), [join(app, "dist", "cli.js"), "--version"], app);

    if (kind === "cli") {
      for (const name of ["luban", "luban-cli"]) {
        const target = join(bin, name);
        copyFileSync(join(root, "packaging", "linux", "luban"), target);
        chmodSync(target, 0o755);
      }
    } else {
      const electronSource = join(root, "node_modules", "electron", "dist");
      if (!existsSync(join(electronSource, "electron"))) throw new Error("Electron runtime missing; run npm ci before package:linux:desktop");
      const electron = join(payload, "electron");
      cpSync(electronSource, electron, { recursive: true });
      chmodSync(join(electron, "chrome-sandbox"), 0o4755);
      cpSync(join(root, "apps", "desktop"), join(payload, "desktop"), { recursive: true });
      const launcher = join(bin, "luban-desktop");
      copyFileSync(join(root, "packaging", "linux", "luban-desktop"), launcher);
      chmodSync(launcher, 0o755);
      const applications = join(stage, "usr", "share", "applications");
      const icons = join(stage, "usr", "share", "icons", "hicolor");
      mkdirSync(applications, { recursive: true });
      mkdirSync(icons, { recursive: true });
      copyFileSync(join(root, "packaging", "linux", "luban.desktop"), join(applications, "luban-desktop.desktop"));
      for (const size of [16, 24, 32, 48, 64, 128, 192, 256, 512]) {
        const directory = join(icons, `${size}x${size}`, "apps");
        mkdirSync(directory, { recursive: true });
        copyFileSync(join(root, "assets", `luban-${size}.png`), join(directory, "luban.png"));
      }
    }

    const metadata = join(stage, "DEBIAN");
    mkdirSync(metadata);
    const desktopDependencies = ", libnss3, libatk1.0-0, libatk-bridge2.0-0, libgtk-3-0 | libgtk-3-0t64, libasound2 | libasound2t64, libgbm1";
    writeFileSync(join(metadata, "control"), [
      `Package: ${packageName}`, `Version: ${version}`, `Architecture: ${architecture}`,
      "Maintainer: luban <noreply@github.com>", "Section: devel", "Priority: optional",
      "Conflicts: luban", "Replaces: luban",
      `Depends: libc6 (>= 2.28), libstdc++6${kind === "desktop" ? desktopDependencies : ""}`,
      `Description: luban ${kind === "desktop" ? "graphical coding workspace" : "command-line coding agent"}`,
      kind === "desktop" ? " Browse project files and code in a desktop window." : " Run the luban Agent in a terminal or script.", "",
    ].join("\n"));
    const output = join(root, "release");
    mkdirSync(output, { recursive: true });
    const deb = join(output, `${packageName}_${version}_${architecture}.deb`);
    run(`Package ${kind} installer`, "dpkg-deb", ["--build", "--root-owner-group", stage, deb], root);
    process.stdout.write(`\nInstaller: ${deb}\n`);
  } finally {
    rmSync(stage, { recursive: true, force: true });
  }
}

run("Build luban", process.execPath, [join(root, "scripts", "build.mjs")], root);
if (selection === "all" || selection === "cli") packageVariant("cli");
if (selection === "all" || selection === "desktop") packageVariant("desktop");
