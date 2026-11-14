import { spawn } from "node:child_process";

/**
 * One desktop notification, without a platform framework.
 *
 * The reminder story is only honest if "到点了" actually reaches a human, and
 * that has to work on every machine the queue runs on — not just the Mac in
 * front of us. Every platform already ships a one-liner for this:
 *
 *   macOS    osascript (Notification Center)
 *   Linux    notify-send (libnotify; silently absent on bare servers)
 *   Windows  PowerShell + WinRT toast (Windows 10+)
 *
 * Nothing here throws: a missing notifier must never fail a bot task, because
 * the task's result is still recorded in the queue.
 */
export interface NotifyCommand {
  command: string;
  args: string[];
}

/** Escape for an AppleScript double-quoted literal. */
function appleScript(value: string): string {
  return value.replace(/\\/gu, "\\\\").replace(/"/gu, '\\"').replace(/\n/gu, " ");
}

/** PowerShell single-quoted literal: the only escaping it needs is doubling `'`. */
function powerShell(value: string): string {
  return `'${value.replace(/\r?\n/gu, " ").replace(/'/gu, "''")}'`;
}

/**
 * The Windows toast, as a PowerShell one-liner the OS already understands.
 * ToastText02 is title + body; `luban` is the registered app id, and Windows
 * attributes the toast to it without any install step. The strings go in the
 * script itself because `-Command` appends extra arguments as raw script text.
 */
function windowsToast(title: string, body: string): string {
  return [
    "$ErrorActionPreference='Stop'",
    "[Windows.UI.Notifications.ToastNotificationManager, Windows.UI.Notifications, ContentType=WindowsRuntime] | Out-Null",
    "$t=[Windows.UI.Notifications.ToastNotificationManager]::GetTemplateContent([Windows.UI.Notifications.ToastTemplateType]::ToastText02)",
    "$x=$t.GetElementsByTagName('text')",
    `$x.Item(0).AppendChild($t.CreateTextNode(${powerShell(title)})) | Out-Null`,
    `$x.Item(1).AppendChild($t.CreateTextNode(${powerShell(body)})) | Out-Null`,
    "[Windows.UI.Notifications.ToastNotificationManager]::CreateToastNotifier('luban').Show([Windows.UI.Notifications.ToastNotification]::new($t))",
  ].join("; ");
}

/** The command that shows one notification, or undefined when the platform has none. */
export function notifyCommand(platform: NodeJS.Platform, title: string, body: string): NotifyCommand | undefined {
  if (platform === "darwin") {
    return { command: "osascript", args: ["-e", `display notification "${appleScript(body)}" with title "${appleScript(title)}"`] };
  }
  if (platform === "linux" || platform === "freebsd" || platform === "openbsd") {
    return { command: "notify-send", args: ["--app-name", "luban", title, body] };
  }
  if (platform === "win32") {
    return { command: "powershell.exe", args: ["-NoProfile", "-NonInteractive", "-Command", windowsToast(title, body)] };
  }
  return undefined;
}

export interface NotifyOptions {
  /** Milliseconds before a stuck notifier is abandoned; the caller never waits longer. */
  timeout?: number;
  platform?: NodeJS.Platform;
}

/** Show a notification. Resolves true only when the platform accepted it. */
export async function notifyUser(title: string, body: string, options: NotifyOptions = {}): Promise<boolean> {
  const command = notifyCommand(options.platform ?? process.platform, title, body);
  if (!command) return false;
  const timeout = options.timeout ?? 5000;
  return new Promise<boolean>(resolve => {
    let settled = false;
    let timer: NodeJS.Timeout | undefined;
    const finish = (ok: boolean) => { if (!settled) { settled = true; if (timer) clearTimeout(timer); resolve(ok); } };
    let child;
    try {
      child = spawn(command.command, command.args, { stdio: "ignore" });
    } catch {
      finish(false);
      return;
    }
    timer = setTimeout(() => { finish(false); try { child.kill("SIGKILL"); } catch { /* already gone */ } }, timeout);
    timer.unref?.();
    child.once("error", () => finish(false));
    child.once("exit", code => finish(code === 0));
  });
}
