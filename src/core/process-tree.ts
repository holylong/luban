import { spawn, type ChildProcess } from "node:child_process";
import { join } from "node:path";

/** Terminate owned process groups on Unix; request taskkill's tree cleanup on Windows.
 * Unix callers must spawn with detached:true. This does not contain daemonized escapees.
 */
export function terminateProcessTree(child: ChildProcess): void {
  if (!child.pid) return;
  if (process.platform === "win32") {
    if (child.exitCode !== null || child.signalCode !== null) return;
    const killer = spawn(join(process.env.SystemRoot || "C:\\Windows", "System32", "taskkill.exe"),
      ["/PID", String(child.pid), "/T", "/F"], { windowsHide: true, stdio: "ignore" });
    const fallback = () => { try { child.kill("SIGKILL"); } catch { /* already exited */ } };
    killer.on("error", fallback);
    killer.on("exit", (code) => { if (code) fallback(); });
    killer.unref();
    return;
  }
  try { process.kill(-child.pid, "SIGKILL"); } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ESRCH") {
      try { child.kill("SIGKILL"); } catch { /* already exited */ }
    }
  }
}
