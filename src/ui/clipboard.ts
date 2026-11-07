import { spawn } from "node:child_process";
import type { ChatMessage, PendingInput } from "../core/types.js";
import type { ExecutionEntry } from "./execution-view.js";

/** OSC 52 clipboard write. Works in xterm/Windows Terminal/iTerm2/ghostty even with mouse reporting on. */
export function osc52CopySequence(text: string): string {
  const payload = Buffer.from(text, "utf8").toString("base64");
  return `\x1b]52;c;${payload}\x07`;
}

/**
 * One way to reach the system clipboard.
 *
 * `args` returns null when the payload does not fit that writer (Windows caps a
 * command line), and `stdin` returns null when the text is already carried in
 * the arguments. Both are functions so a large selection can skip the first
 * writer and fall through to the next instead of failing outright.
 */
export interface ClipboardWriter {
  command: string;
  args: (text: string) => string[] | null;
  stdin?: (text: string) => string | Buffer | null;
  timeoutMs?: number;
}

/** Longest base64 payload that stays well inside the Windows command-line limit. */
const MAX_POWERSHELL_PAYLOAD = 20000;

/**
 * `Set-Clipboard` with the text as a base64 argument.
 *
 * Piping text into clip.exe decodes it with the console code page, so a Chinese
 * selection reaches the clipboard as mojibake. PowerShell is given the UTF-8
 * bytes instead and decodes them itself, which is independent of the console.
 */
export function powershellClipboardArgs(text: string): string[] | null {
  const payload = Buffer.from(text, "utf8").toString("base64");
  if (!payload || payload.length > MAX_POWERSHELL_PAYLOAD) return null;
  return [
    "-NoProfile", "-NonInteractive", "-Command",
    `Set-Clipboard -Value ([Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${payload}')))`,
  ];
}

/**
 * Clipboard helpers for the current platform, in the order they are tried.
 *
 * OSC 52 alone is not enough: Windows Terminal and conhost ignore it, and VTE
 * (GNOME Terminal) disables clipboard writes from applications by default, so a
 * copy that "succeeded" over OSC 52 never reaches the user's Ctrl+V. A native
 * helper writes straight to the desktop clipboard, which is the path that works.
 */
export function clipboardWriters(platform: NodeJS.Platform = process.platform): ClipboardWriter[] {
  if (platform === "darwin") return [
    { command: "pbcopy", args: () => [], stdin: (text) => text },
  ];
  if (platform === "win32") return [
    // PowerShell starts slower than clip.exe but handles CJK and long text.
    { command: "powershell.exe", args: powershellClipboardArgs, timeoutMs: 5000 },
    // Last resort: ASCII-only in practice, but better than losing the copy.
    { command: "clip", args: () => [], stdin: (text) => text, timeoutMs: 2000 },
  ];
  return [
    { command: "wl-copy", args: () => [], stdin: (text) => text },
    { command: "xclip", args: () => ["-selection", "clipboard"], stdin: (text) => text },
    { command: "xsel", args: () => ["--clipboard", "--input"], stdin: (text) => text },
  ];
}

/** Run one writer; resolve true only on a clean exit. */
function runWriter(writer: ClipboardWriter, text: string): Promise<boolean> {
  const args = writer.args(text);
  if (!args) return Promise.resolve(false);
  const input = writer.stdin ? writer.stdin(text) : null;
  return new Promise((resolve) => {
    let settled = false;
    const done = (value: boolean) => { if (!settled) { settled = true; resolve(value); } };
    let child: ReturnType<typeof spawn>;
    try {
      child = spawn(writer.command, args, { stdio: [input === null ? "ignore" : "pipe", "ignore", "ignore"] });
    } catch {
      done(false);
      return;
    }
    const timer = setTimeout(() => { child.kill(); done(false); }, writer.timeoutMs ?? 1500);
    timer.unref?.();
    child.on("error", () => { clearTimeout(timer); done(false); });
    child.on("close", (code) => { clearTimeout(timer); done(code === 0); });
    child.stdin?.on("error", () => { /* EPIPE when the helper died early; close decides. */ });
    if (input !== null) child.stdin?.end(input);
  });
}

/** Write the system clipboard through the first native helper that works. */
export async function writeSystemClipboard(text: string, platform: NodeJS.Platform = process.platform): Promise<boolean> {
  for (const writer of clipboardWriters(platform)) {
    if (await runWriter(writer, text)) return true;
  }
  return false;
}

export function lastAssistantText(messages: ChatMessage[]): string {
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const m = messages[i]!;
    if (m.role === "assistant" && !m.tool_calls?.length && String(m.content ?? "").trim()) {
      return String(m.content);
    }
  }
  return "";
}

/** Plain-text bundle for /copy: last answer + recent tool results + pending steering. */
export function buildCopyText(
  messages: ChatMessage[],
  entries: ExecutionEntry[] = [],
  pending: PendingInput[] = [],
  outcomeText = "",
): string {
  const parts: string[] = [];
  const answer = lastAssistantText(messages);
  if (answer.trim()) parts.push(`## luban 回答\n\n${answer.trim()}`);
  const recent = entries.slice(-6);
  if (recent.length) {
    const lines = recent.map((e) => {
      const head = `- ${e.name}${e.detail ? ` ${e.detail}` : ""} [${e.status}]`;
      const preview = (e.preview || e.editPreview || "").trim().split("\n").slice(0, 20).join("\n");
      return preview ? `${head}\n${preview}` : head;
    });
    parts.push(`## 最近工具调用\n\n${lines.join("\n\n")}`);
  }
  if (outcomeText.trim()) parts.push(`## 运行状态\n\n${outcomeText.trim()}`);
  if (pending.length) {
    parts.push(`## 待处理补充指令\n\n${pending.map((p) => `- [${p.delivery}] ${p.content}`).join("\n")}`);
  }
  return parts.length ? `${parts.join("\n\n")}\n` : "";
}
