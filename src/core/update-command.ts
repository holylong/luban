/* `luban update` — check, install, and the on/off switch.
 *
 * The terminal is where an upgrade is least surprising: the user voluntarily
 * typed something, so the command can download 50 MB and say exactly what it
 * replaced. Clients with a UI call the same functions in `core/update.ts`; this
 * module only owns wording, exit codes and the `--json` shape.
 */
import { Command } from "commander";
import { loadConfig, saveUpdateSettings } from "./config.js";
import { VERSION } from "../version.js";
import { DEFAULT_UPDATE_URL } from "./service-defaults.js";
import {
  checkForUpdate, cliInstallRoot, currentKind, downloadUpdate, installUpdate, releaseEndpoint, type UpdateCheck,
} from "./update.js";

function formatBytes(value: number): string {
  if (value >= 1024 * 1024) return `${(value / (1024 * 1024)).toFixed(1)} MB`;
  if (value >= 1024) return `${Math.round(value / 1024)} KB`;
  return `${value} B`;
}

/** One line per outcome, so a script can show the check without parsing JSON. */
export function describeCheck(check: UpdateCheck): string {
  const notes = check.artifact?.notes?.trim();
  const suffix = notes ? `\n${notes}` : "";
  switch (check.status) {
    case "available":
      return `有新版本 ${check.latest ?? check.artifact?.version}（当前 ${check.current}）：${check.artifact?.file} · ${formatBytes(check.artifact?.size ?? 0)}${suffix}\n升级：luban update install`;
    case "current":
      return `已是最新版本 ${check.current}`;
    case "no-build":
      return `服务器上有 ${check.latest}，但没有当前平台（${currentKind()}）的安装包`;
    case "skipped":
      return `${check.latest ?? check.artifact?.version} 已被「不再提醒」，仍可手动升级：luban update install`;
    case "disabled":
      return "自动检测更新已关闭（luban update on 打开）";
    default:
      return `无法检查更新：${check.reason ?? "未知原因"}`;
  }
}

/** Shared by every surface that wants the release notes trimmed for one line. */
export function shortNotes(notes: string, max = 160): string {
  const text = notes.replace(/\s+/gu, " ").trim();
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

export async function runUpdate(argv: string[]): Promise<number> {
  const program = new Command();
  program
    .name("luban update")
    .description("Check for a newer luban, install it, or switch the startup check")
    .version(VERSION)
    .argument("[action]", "check (default), install, on, off, status")
    .option("--json", "print machine-readable JSON")
    .option("--notes", "print the full release notes")
    .showHelpAfterError();
  program.parse(argv, { from: "user" });
  const action = (program.args[0] ?? "check") as string;
  const options = program.opts<{ json?: boolean; notes?: boolean }>();
  const config = loadConfig({ workspace: process.cwd() });
  const settings = config.updates;

  if (!["check", "install", "on", "off", "status"].includes(action)) {
    process.stderr.write(`未知的操作：${action}\n可用：check、install、on、off、status\n`);
    return 1;
  }

  if (action === "on" || action === "off") {
    const check = action === "on";
    await saveUpdateSettings(config.home, { check });
    if (options.json) {
      process.stdout.write(`${JSON.stringify({ ok: true, check }, null, 2)}\n`);
    } else {
      process.stdout.write(check ? "已打开自动检测更新（启动时检查一次）\n" : "已关闭自动检测更新；luban update 仍可手动检查\n");
    }
    return 0;
  }

  if (action === "status") {
    const payload = {
      version: VERSION,
      kind: currentKind(),
      check: settings.check,
      skipped: settings.skippedVersion || null,
      endpoint: releaseEndpoint(settings.url || DEFAULT_UPDATE_URL),
      installRoot: cliInstallRoot() ?? null,
    };
    if (options.json) {
      process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
      return 0;
    }
    process.stdout.write(`版本 ${VERSION}（${payload.kind}）\n自动检测：${settings.check ? "开" : "关"}\n`);
    process.stdout.write(`服务器：${payload.endpoint}\n`);
    process.stdout.write(`不再提醒：${settings.skippedVersion || "无"}\n`);
    return 0;
  }

  if (!settings.check && action !== "install") {
    // `check` honours the switch; an explicit install is the user overriding it.
    if (options.json) process.stdout.write(`${JSON.stringify({ status: "disabled", current: VERSION }, null, 2)}\n`);
    else process.stdout.write("自动检测更新已关闭（luban update on 打开，luban update install 直接升级）\n");
    return 0;
  }

  const check = await checkForUpdate({
    currentVersion: VERSION,
    kind: currentKind(),
    url: settings.url,
    skippedVersion: settings.skippedVersion,
  });

  if (action === "install") {
    if (check.status === "current") {
      if (options.json) process.stdout.write(`${JSON.stringify({ ok: true, status: "current", version: VERSION }, null, 2)}\n`);
      else process.stdout.write(`已是最新版本 ${VERSION}\n`);
      return 0;
    }
    if (check.status !== "available" && check.status !== "skipped") {
      process.stderr.write(`${describeCheck(check)}\n`);
      return 1;
    }
    const artifact = check.artifact!;
    process.stderr.write(`正在下载 ${artifact.file}（${formatBytes(artifact.size)}）…\n`);
    let lastPercent = -1;
    const archive = await downloadUpdate(artifact, {
      baseUrl: settings.url,
      home: config.home,
      onProgress: (received, total) => {
        if (!process.stderr.isTTY) return;
        const percent = Math.min(100, Math.floor((received / total) * 100));
        if (percent <= lastPercent) return;
        lastPercent = percent;
        process.stderr.write(`\r下载中 ${percent}%  ${formatBytes(received)} / ${formatBytes(total)}`);
      },
    });
    if (process.stderr.isTTY) process.stderr.write("\n");
    process.stderr.write(`已下载并校验：${archive}\n`);
    const installed = await installUpdate(artifact, archive, { kind: currentKind(), home: config.home });
    if (options.json) {
      process.stdout.write(`${JSON.stringify({ ok: true, installed: installed.target, archive, restart: installed.restart }, null, 2)}\n`);
      return 0;
    }
    if (installed.restart === "relaunch") {
      process.stdout.write(`已安装 ${artifact.version} 到 ${installed.target}，应用会自动重启。\n`);
    } else {
      process.stdout.write(`已安装 ${artifact.version} 到 ${installed.target}，重新打开 luban 生效。\n`);
    }
    return 0;
  }

  if (options.json) {
    process.stdout.write(`${JSON.stringify(check, null, 2)}\n`);
    return 0;
  }
  if (options.notes && check.artifact?.notes) {
    process.stdout.write(`${check.artifact.notes}\n\n`);
  }
  process.stdout.write(`${describeCheck(check)}\n`);
  // A failed check is not a command failure: the user did not do anything wrong
  // and a script should not start treating "offline" as "upgrade broke".
  return 0;
}
