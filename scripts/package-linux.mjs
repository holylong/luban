/** Build a self-contained Linux .deb: Node runtime, production modules, and launcher icon. */
import { spawnSync } from "node:child_process";
import { chmodSync, copyFileSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const version = JSON.parse(readFileSync(join(root, "package.json"), "utf8")).version;
const architecture = { x64: "amd64", arm64: "arm64" }[process.arch];
if (process.platform !== "linux" || !architecture) throw new Error("package:linux requires Linux x64 or arm64");

function run(label, command, args, cwd) {
  process.stdout.write(`\n> ${label}\n`);
  const result = spawnSync(command, args, { cwd, stdio: "inherit", shell: false });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`${label} failed (${result.status})`);
}

const stage = mkdtempSync(join(tmpdir(), "luban-deb-"));
const output = join(root, "release");
const payload = join(stage, "opt", "luban");
const app = join(payload, "app");
const bin = join(stage, "usr", "bin");
try {
  run("Build luban", process.execPath, [join(root, "scripts", "build.mjs")], root);
  mkdirSync(app, { recursive: true });
  mkdirSync(bin, { recursive: true });
  cpSync(join(root, "dist"), join(app, "dist"), { recursive: true });
  cpSync(join(root, "plugins"), join(app, "plugins"), { recursive: true });
  for (const name of ["package.json", "package-lock.json", "README.md"]) copyFileSync(join(root, name), join(app, name));
  run("Install runtime dependencies", "npm", ["ci", "--omit=dev", "--ignore-scripts", "--no-audit", "--no-fund"], app);
  copyFileSync(process.execPath, join(payload, "node"));
  chmodSync(join(payload, "node"), 0o755);
  run("Smoke test bundled runtime", join(payload, "node"), [join(app, "dist", "cli.js"), "--version"], app);
  const nodeLicense = [resolve(dirname(process.execPath), "..", "LICENSE"), "/usr/share/doc/nodejs/copyright"]
    .find((candidate) => existsSync(candidate));
  if (!nodeLicense) throw new Error("Node.js license not found beside node or in /usr/share/doc/nodejs");
  copyFileSync(nodeLicense, join(payload, "NODE-LICENSE"));
  for (const name of ["luban", "luban-desktop"]) {
    const target = join(bin, name);
    copyFileSync(join(root, "packaging", "linux", name), target);
    chmodSync(target, 0o755);
  }
  const desktop = join(stage, "usr", "share", "applications");
  const icons = join(stage, "usr", "share", "icons", "hicolor", "scalable", "apps");
  mkdirSync(desktop, { recursive: true });
  mkdirSync(icons, { recursive: true });
  copyFileSync(join(root, "packaging", "linux", "luban.desktop"), join(desktop, "luban.desktop"));
  copyFileSync(join(root, "assets", "luban.svg"), join(icons, "luban.svg"));
  const metadata = join(stage, "DEBIAN");
  mkdirSync(metadata);
  writeFileSync(join(metadata, "control"), [
    "Package: luban", `Version: ${version}`, `Architecture: ${architecture}`,
    "Maintainer: luban <noreply@github.com>", "Section: devel", "Priority: optional",
    "Depends: libc6 (>= 2.28), libstdc++6",
    "Description: luban coding agent with a desktop launcher and bundled Node.js",
    " Run luban from the applications menu or with the luban command.", "",
  ].join("\n"));
  mkdirSync(output, { recursive: true });
  const deb = join(output, `luban_${version}_${architecture}.deb`);
  run("Package desktop installer", "dpkg-deb", ["--build", "--root-owner-group", stage, deb], root);
  process.stdout.write(`\nInstaller: ${deb}\n`);
} finally {
  rmSync(stage, { recursive: true, force: true });
}
