import { mkdtemp, writeFile, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { AgentRunner } from "./agent.js";
import type { LubanConfig } from "./types.js";
const roots: string[] = [];
const runners: AgentRunner[] = [];
afterEach(async () => {
  runners.splice(0).forEach((runner) => runner.close());
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true, maxRetries: 20, retryDelay: 25 })));
});
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "luban-process-")); roots.push(root);
  const runner = new AgentRunner({ home: root, workspace: root, project: "test", model: { name: "test" } } as LubanConfig);
  runners.push(runner);
  await writeFile(join(root, "tree.cjs"), `
const fs = require('node:fs');
process.on('SIGTERM', () => {});
if (process.argv[2] === 'leaf') {
  fs.writeFileSync('leaf.pid', String(process.pid));
} else {
  fs.writeFileSync('parent.pid', String(process.pid));
  require('node:child_process').spawn(process.execPath, ['tree.cjs', 'leaf'], { stdio: 'inherit' });
}
setInterval(() => {}, 1000);
`);
  return { root, runner, bash: runner.tools.get("bash")!, inspect: runner.tools.get("get_background_task")! };
}
async function stopped(pid: number) {
  try { process.kill(pid, 0); } catch { return true; }
  // Container PID 1 may defer reaping an orphan; zombies no longer execute.
  try { return (await readFile(`/proc/${pid}/stat`, "utf8")).split(") ")[1]?.startsWith("Z") ?? false; } catch { return true; }
}
for (const action of ["close", "cancel"] as const) {
  it.skipIf(process.platform !== "linux")(`${action} terminates a managed background tree even when descendants ignore SIGTERM`, async () => {
    const f = await fixture();
    const controller = new AbortController();
    const id = (await f.bash.execute({ command: `"${process.execPath}" tree.cjs`, background: true }, controller.signal)).match(/background task ([^ ]+)/)![1]!;
    let parent = 0, leaf = 0;
    await vi.waitFor(async () => {
      parent = Number(await readFile(join(f.root, "parent.pid"), "utf8"));
      leaf = Number(await readFile(join(f.root, "leaf.pid"), "utf8"));
    }, { timeout: 3000, interval: 20 });
    if (action === "close") f.runner.close(); else controller.abort(new Error("cancelled"));
    await vi.waitFor(async () => {
      expect(await stopped(parent)).toBe(true); expect(await stopped(leaf)).toBe(true);
      expect(JSON.parse(await f.inspect.execute({ task_id: id }, new AbortController().signal)).status).toBe("stopped");
    }, { timeout: 3000, interval: 20 });
  });
}
it.skipIf(process.platform === "win32")("reports signal termination as failure and refuses a pre-cancelled command", async () => {
  const f = await fixture();
  await expect(f.bash.execute({ command: "kill -TERM $$" }, new AbortController().signal)).rejects.toThrow("terminated by SIGTERM");
  const controller = new AbortController(); controller.abort(new Error("cancelled"));
  await expect(f.bash.execute({ command: "touch bad.txt", background: true }, controller.signal)).rejects.toThrow("cancelled");
  await expect(readFile(join(f.root, "bad.txt"))).rejects.toThrow();
});
it("closing a runner cancels a pending model request", async () => {
  const f = await fixture();
  let started!: () => void;
  const ready = new Promise<void>((resolve) => { started = resolve; });
  const runner = new AgentRunner({ ...f.runner.config, maxSteps: 2, maxTokens: 1000 }, { async complete(_messages, _tools, signal) {
    started();
    return await new Promise<never>((_resolve, reject) => signal.addEventListener("abort", () => reject(signal.reason), { once: true }));
  } }); runners.push(runner);
  const run = runner.run([{ role: "user", content: "work" }], "agent", new AbortController().signal, () => {}, async () => "always");
  const rejection = expect(run).rejects.toThrow("runner closed");
  await ready;
  runner.close();
  await rejection;
});
