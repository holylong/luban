import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { createTools } from "./tools.js";
import type { LubanConfig, ToolDefinition } from "./types.js";

const roots: string[] = [], handles: ToolDefinition[] = [];
afterEach(async () => {
  vi.useRealTimers();
  handles.splice(0).forEach(tool => tool.close?.());
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 25 })));
});
it("cancels commands automatically moved to background just like explicit background tasks", async () => {
  const workspace = await mkdtemp(join(tmpdir(), "luban-background-lifecycle-")); roots.push(workspace);
  const tools = createTools({ workspace, home: workspace, project: "test", model: { name: "test" } } as LubanConfig);
  handles.push(...tools.values());
  const controller = new AbortController();
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  const run = tools.get("bash")!.execute({ command: 'node -e "setInterval(()=>{},1000)"' }, controller.signal);
  await vi.advanceTimersByTimeAsync(15_000);
  const output = await run;
  expect(output).toContain("started after 15s");
  const id = output.match(/background task (\S+)/u)![1];
  vi.useRealTimers();
  controller.abort(new Error("cancelled"));
  await vi.waitFor(async () => {
    const task = JSON.parse(await tools.get("get_background_task")!.execute({ task_id: id }, new AbortController().signal));
    expect(task.status).toBe("stopped");
  }, { timeout: 5000 });
});
