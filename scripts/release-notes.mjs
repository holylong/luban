/**
 * Compose the GitHub Release body for one version.
 *
 * The workflow used to hard-code the install table into every packaging job and
 * then rewrite the body once more at the end, so the published notes were an
 * install manual with no mention of what changed — the opposite of what a user
 * on the release page needs. This script is the single source of that body:
 * this version's CHANGELOG section first, then the packages it produced.
 *
 *   node scripts/release-notes.mjs --version 2.9.6 [--platform all|linux|windows|macos] [--out notes.md]
 *
 * A version without a CHANGELOG section is an error, matching `publish:release`:
 * a release nobody can describe is not worth announcing.
 */
import { readFile, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { changelogNotes } from "./publish-release.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");

/** @typedef {"all" | "linux" | "windows" | "macos"} Platform */

/**
 * Install instructions for one platform, written for the release page reader
 * rather than for the build machine.
 * @param {"linux" | "windows" | "macos"} platform @param {string} version
 */
function platformSection(platform, version) {
  if (platform === "linux") {
    return [
      "**Linux**（`.deb`，安装后直接运行）",
      "",
      `- \`luban-cli_${version}_amd64.deb\`：终端版，安装后运行 \`luban\` 或 \`luban-cli\`。`,
      `- \`luban-desktop_${version}_amd64.deb\`：图形桌面版，安装后运行 \`luban-desktop\`。`,
      `- \`luban-creator_${version}_amd64.deb\`：造物主，安装后从应用菜单打开 luban Creator，或运行 \`luban-creator\`。`,
      "",
      "配置目录：`~/.luban/config.json`。",
    ].join("\n");
  }
  if (platform === "windows") {
    return [
      "**Windows x64**（便携 ZIP，解压即用，已内置 Node.js）",
      "",
      `- \`luban-cli-${version}-win-x64.zip\`：终端版，解压后运行 \`luban.cmd\`。`,
      `- \`luban-desktop-${version}-win-x64.zip\`：图形桌面版，解压后运行 \`luban-desktop.cmd\`（含 \`luban.cmd\`）。`,
      `- \`luban-creator-${version}-win-x64.zip\`：造物主，解压后运行 \`luban-creator.cmd\`。`,
      "",
      "配置目录：`%USERPROFILE%\\.luban\\config.json`。",
    ].join("\n");
  }
  return [
    "**macOS**（无需安装，已内置 Node.js；x64 与 arm64 各一份）",
    "",
    `- \`luban-cli-${version}-mac-x64.zip\` / \`luban-cli-${version}-mac-arm64.zip\`：终端版，解压后运行 \`./luban\`。`,
    `- \`luban-desktop-${version}-mac-x64.dmg\` / \`luban-desktop-${version}-mac-arm64.dmg\`：把卷内 \`luban Desktop.app\` 拖入「应用程序」。`,
    `- \`luban-creator-${version}-mac-x64.dmg\` / \`luban-creator-${version}-mac-arm64.dmg\`：把卷内 \`Creator.app\` 拖入「应用程序」。`,
    "  桌面版和造物主无法生成镜像时，改为发布同名 `.zip`。",
    "",
    "macOS 包为 ad-hoc 签名，首次打开若被 Gatekeeper 拦截，执行 `xattr -dr com.apple.quarantine .`。",
    "",
    "配置目录：`~/.luban/config.json`。",
  ].join("\n");
}

/** @param {string} platform @returns {"linux" | "windows" | "macos"} */
function checkPlatform(platform) {
  if (platform === "linux" || platform === "windows" || platform === "macos") return platform;
  throw new Error(`unknown platform ${platform}: expected all, linux, windows or macos`);
}

/**
 * Build the release body: what changed, then how to install it.
 * @param {{ version: string, changelog: string, platform?: Platform }} options
 */
export function releaseBody({ version, changelog, platform = "all" }) {
  const changes = changelogNotes(version, changelog);
  if (!changes) {
    throw new Error(`CHANGELOG.md has no "## ${version} — <date>" section: write it before publishing, or pass --notes-file yourself`);
  }
  /** @type {("linux" | "windows" | "macos")[]} */
  const wanted = platform === "all" ? ["linux", "windows", "macos"] : [checkPlatform(platform)];
  const sections = wanted.map(item => platformSection(item, version));
  return [
    "## 更新内容",
    "",
    changes,
    "",
    "## 安装包",
    "",
    sections.join("\n\n"),
    "",
  ].join("\n");
}

/**
 * Repair an already-published body: keep whatever install text is in it and put
 * 更新内容 in front. Old bodies name the files that were really uploaded, so they
 * are never regenerated from this version's naming scheme.
 *
 * Returns "" when the body already carries 更新内容, which makes the repair
 * idempotent and safe to re-run from a workflow.
 *
 * @param {{ version: string, changelog: string, base: string }} options
 */
export function mergeWithBase({ version, changelog, base }) {
  const text = String(base ?? "").replace(/\r\n/gu, "\n");
  if (/^##\s*更新内容\s*$/mu.test(text)) return "";
  const changes = changelogNotes(version, changelog);
  if (!changes) throw new Error(`CHANGELOG.md has no "## ${version} — <date>" section: cannot describe this release`);
  const rest = text.replace(/^\s+|\s+$/gu, "");
  if (!rest) return releaseBody({ version, changelog });
  return `## 更新内容\n\n${changes}\n\n---\n\n${rest}\n`;
}

/**
 * Parse `--flag value` pairs; an unknown flag is an error rather than silently ignored.
 * @param {string[]} argv
 */
export function parseArgs(argv) {
  /** @type {{ version?: string, platform: string, changelog: string, out?: string, base?: string, help?: boolean }} */
  const options = { platform: "all", changelog: join(root, "CHANGELOG.md") };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--help" || arg === "-h") return { ...options, help: true };
    if (arg !== "--version" && arg !== "--platform" && arg !== "--changelog" && arg !== "--out" && arg !== "--base") {
      throw new Error(`unknown option ${arg}`);
    }
    const value = argv[index + 1];
    if (value === undefined || value.startsWith("--")) throw new Error(`${arg} needs a value`);
    index += 1;
    if (arg === "--version") options.version = value;
    else if (arg === "--platform") options.platform = value;
    else if (arg === "--changelog") options.changelog = value;
    else if (arg === "--base") options.base = value;
    else options.out = value;
  }
  if (!/^\d{1,3}\.\d{1,3}\.\d{1,3}$/u.test(String(options.version ?? ""))) {
    throw new Error("--version must look like MAJOR.MINOR.PATCH");
  }
  if (options.platform !== "all") checkPlatform(options.platform);
  return options;
}

const help = `Usage: node scripts/release-notes.mjs --version X.Y.Z [options]

  --version    the version whose CHANGELOG section becomes 更新内容
  --platform   all (default), linux, windows or macos
  --changelog  CHANGELOG.md to read (default: this repository's)
  --out        write the body to a file instead of stdout
  --base       repair an existing body: keep it verbatim, prepend 更新内容
`;

/**
 * @param {string[]} argv
 * @param {{ changelog?: string, read?: (path: string) => Promise<string>, write?: (path: string, text: string) => Promise<void>, stdout?: (text: string) => void }} [deps]
 */
export async function main(argv = process.argv.slice(2), deps = {}) {
  const options = parseArgs(argv);
  if (options.help) {
    (deps.stdout ?? (text => process.stdout.write(text)))(help);
    return 0;
  }
  const changelog = deps.changelog ?? await readFile(options.changelog, "utf8");
  const version = String(options.version);
  const say = deps.stdout ?? (text => process.stdout.write(text));
  let body = releaseBody({ version, changelog, platform: options.platform });
  if (options.base) {
    const existing = await (deps.read ?? (path => readFile(path, "utf8")))(options.base);
    body = mergeWithBase({ version, changelog, base: existing });
    if (!body) {
      say(`notes unchanged: ${version} already leads with 更新内容\n`);
      return 0;
    }
  }
  if (options.out) {
    await (deps.write ?? ((path, text) => writeFile(path, text, "utf8")))(options.out, body);
    say(`notes written: ${options.out} (${body.length} chars)\n`);
  } else {
    say(body);
  }
  return 0;
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) {
  main().then(code => process.exit(code)).catch(error => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exit(1);
  });
}
