import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { LubanConfig } from "./types.js";

/** Resolve the compiled child script. Source runs (tsx/vitest) map src/ to dist/. */
export function codeIntelChildScript(): string | null {
  try {
    const here = fileURLToPath(import.meta.url);
    const sibling = join(dirname(here), "code-intel-child.js");
    if (existsSync(sibling)) return sibling;
    // Source runs (tsx/vitest) map src/core/*.ts to dist/core/*.js by package root.
    const root = here.includes(`${"/"}src${"/"}core${"/"}`)
      ? here.slice(0, here.indexOf(`${"/"}src${"/"}core${"/"}`))
      : dirname(dirname(here));
    const dist = join(root, "dist", "core", "code-intel-child.js");
    return existsSync(dist) ? dist : null;
  } catch {
    return null;
  }
}

/** Run one code-intelligence query in a disposable child process. */
export function runCodeIntelInChild(
  workspace: string,
  lspServers: LubanConfig["lspServers"],
  args: Record<string, unknown>,
  signal: AbortSignal,
  timeoutMs: number,
): Promise<string> {
  const script = codeIntelChildScript();
  if (!script) return Promise.reject(new Error("code-intel child is unavailable (package dist not built)"));
  signal.throwIfAborted();
  return new Promise<string>((resolvePromise, reject) => {
    let settled = false;
    const child = spawn(process.execPath, [script, JSON.stringify({ workspace, lspServers: lspServers ?? {}, args })], {
      cwd: workspace,
      env: { ...process.env, LUBAN_CODE_CHILD: "1" },
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });
    let output = "";
    let stderr = "";
    const finish = (error?: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal.removeEventListener("abort", abort);
      try {
        child.kill("SIGKILL");
      } catch { /* already exited */ }
      if (error) {
        reject(error);
        return;
      }
      try {
        const parsed = JSON.parse(output.trim().split("\n").at(-1) || "") as { ok: boolean; result?: string; error?: string };
        if (parsed.ok) resolvePromise(String(parsed.result ?? ""));
        else reject(new Error(String(parsed.error || "code-intel child failed")));
      } catch {
        reject(new Error(`code-intel child returned unreadable output${stderr.trim() ? `: ${stderr.trim().slice(0, 400)}` : ""}`));
      }
    };
    const timer = setTimeout(() => finish(new Error(`code intelligence timed out after ${timeoutMs}ms in an isolated worker`)), Math.max(100, timeoutMs));
    const abort = () => finish(signal.reason instanceof Error ? signal.reason : new Error("aborted"));
    signal.addEventListener("abort", abort, { once: true });
    child.stdout.on("data", (chunk: Buffer) => {
      output += chunk.toString("utf8");
      if (output.length > 4_000_000) finish(new Error("code-intel child output exceeds 4 MB"));
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderr = `${stderr}${chunk.toString("utf8")}`.slice(-2000);
    });
    child.on("error", (error) => finish(error));
    child.on("close", (code) => {
      if (!settled && code !== 0 && !output.trim()) finish(new Error(`code-intel child exited with ${code}${stderr.trim() ? `: ${stderr.trim().slice(0, 400)}` : ""}`));
      else if (!settled) finish();
    });
  });
}
