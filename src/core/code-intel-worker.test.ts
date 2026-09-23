import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { codeIntelChildScript } from "./code-intel-worker.js";
import { codeIntelligenceTool } from "./code-intelligence.js";

const roots: string[] = [];
afterEach(async () => {
  const { rm } = await import("node:fs/promises");
  await Promise.all(roots.splice(0).map((path) => rm(path, { recursive: true, force: true, maxRetries: 20, retryDelay: 25 })));
  delete process.env.LUBAN_CODE_CHILD_DELAY_MS;
});

describe("isolated code-intelligence worker", () => {
  it("answers queries from a disposable child process", async () => {
    if (!codeIntelChildScript()) return;
    const root = await mkdtemp(join(tmpdir(), "luban-ci-worker-"));
    roots.push(root);
    await writeFile(join(root, "a.ts"), "export const answer = 42;\n");
    const tool = codeIntelligenceTool(root, { workspace: root, lspServers: {}, codeIntelWorker: true } as never);
    const signal = new AbortController().signal;
    try {
      const parsed = JSON.parse(await tool.execute({ path: "a.ts", operation: "symbols" }, signal));
      expect(parsed.engine).toBe("typescript");
      expect(parsed.results.map((item: { name: string }) => item.name)).toContain("answer");
    } finally {
      tool.close?.();
    }
  });

  it("kills hung queries without disturbing the agent process", async () => {
    if (!codeIntelChildScript()) return;
    const root = await mkdtemp(join(tmpdir(), "luban-ci-hang-"));
    roots.push(root);
    await writeFile(join(root, "a.ts"), "export const answer = 42;\n");
    process.env.LUBAN_CODE_CHILD_DELAY_MS = "10000";
    const tool = codeIntelligenceTool(root, { workspace: root, lspServers: {}, codeIntelWorker: true } as never);
    try {
      await expect(tool.execute({ path: "a.ts", operation: "symbols", timeout_ms: 500 }, new AbortController().signal))
        .rejects.toThrow(/timed out/);
    } finally {
      delete process.env.LUBAN_CODE_CHILD_DELAY_MS;
      tool.close?.();
    }
  });
});
