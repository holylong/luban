import { describe, expect, it } from "vitest";
import { notifyCommand, notifyUser } from "./notify.js";

/** A reminder that nobody hears is not a reminder: every platform needs a command. */
describe("notifyCommand", () => {
  it("asks Notification Center on macOS, with the text escaped", () => {
    const command = notifyCommand("darwin", "luban 提醒", '他说 "早走" \\ 好');
    expect(command?.command).toBe("osascript");
    expect(command?.args[0]).toBe("-e");
    expect(command?.args[1]).toBe('display notification "他说 \\"早走\\" \\\\ 好" with title "luban 提醒"');
  });

  it("uses notify-send on Linux and plain arguments (no shell quoting)", () => {
    expect(notifyCommand("linux", "luban 提醒", "下班")).toEqual({
      command: "notify-send",
      args: ["--app-name", "luban", "luban 提醒", "下班"],
    });
  });

  it("builds a WinRT toast for Windows with the text inside the script", () => {
    // `-Command` appends trailing arguments as raw script text, so the title and
    // body have to be literals inside the script, not $args.
    const command = notifyCommand("win32", "luban 提醒", "下班 it's 6");
    expect(command?.command).toBe("powershell.exe");
    expect(command?.args.slice(0, 2)).toEqual(["-NoProfile", "-NonInteractive"]);
    expect(command?.args).toHaveLength(4);
    const script = command!.args[3];
    expect(script).toContain("ToastNotificationManager");
    expect(script).toContain("'luban 提醒'");
    expect(script).toContain("'下班 it''s 6'");
  });

  it("reports no command where the platform has none rather than throwing", () => {
    expect(notifyCommand("aix", "t", "b")).toBeUndefined();
  });
});

describe("notifyUser", () => {
  it("resolves false when the platform has no notifier", async () => {
    await expect(notifyUser("t", "b", { platform: "aix" })).resolves.toBe(false);
  });

  it("resolves false instead of hanging when the binary is missing", async () => {
    await expect(notifyUser("t", "b", { platform: "linux", timeout: 2000 })).resolves.toBe(false);
  });
});
