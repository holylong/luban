import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { ToolOutputStore } from "./tool-output.js";

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true, maxRetries: 20, retryDelay: 25 }))); });
async function home() { const root = await mkdtemp(join(tmpdir(), "luban-output-")); roots.push(root); return root; }

it("archives complete tool results and reads them from a new store after resume", async () => {
  const root = await home();
  const original = "BEGIN\n" + "中文测试🙂\n".repeat(5000) + "FAILED at the end";
  const preview = await new ToolOutputStore(root).capture(original);
  expect(preview.length).toBeLessThan(25000);
  expect(preview).toContain("FAILED at the end");
  const id = preview.match(/Full output saved: ([0-9a-f-]+)/)![1]!;
  expect(await readFile(join(root, "tool-output-node", `${id}.txt`), "utf8")).toBe(original);
  const tool = new ToolOutputStore(root).tool();
  let offset = 0;
  let content = "";
  for (;;) {
    const page = JSON.parse(await tool.execute({ output_id: id, offset, limit: 997 }, new AbortController().signal));
    content += page.content;
    expect(page.next_offset).toBeGreaterThan(offset);
    offset = page.next_offset;
    if (page.eof) break;
  }
  expect(content).toBe(original);
});

it("leaves small results inline and rejects paths and invalid page ranges", async () => {
  const root = await home();
  const store = new ToolOutputStore(root);
  expect(await store.capture("small output")).toBe("small output");
  expect(await readdir(root)).toEqual([]);
  const tool = store.tool();
  const signal = new AbortController().signal;
  await expect(tool.execute({ output_id: "../secret" }, signal)).rejects.toThrow("UUID");
  const id = (await store.capture("x".repeat(25000))).match(/Full output saved: ([0-9a-f-]+)/)![1]!;
  await expect(tool.execute({ output_id: id, offset: -1 }, signal)).rejects.toThrow("offset");
  await expect(tool.execute({ output_id: id, limit: 0 }, signal)).rejects.toThrow("limit");
  const page = JSON.parse(await tool.execute({ output_id: id, offset: 30000 }, signal));
  expect(page.eof).toBe(true);
  expect(page.content).toBe("");
});
