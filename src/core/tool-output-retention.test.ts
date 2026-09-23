import { describe, expect, it } from "vitest";
import { mkdtemp, readdir, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ToolOutputStore } from "./tool-output.js";

describe("tool output retention", () => {
  it("prunes expired archives and enforces a byte budget", async () => {
    const home = await mkdtemp(join(tmpdir(), "luban-tool-output-"));
    const store = new ToolOutputStore(home);
    const big = `x`.repeat(30_000);
    const first = await store.capture(big, 7, 10 ** 9);
    const second = await store.capture(`${big}y`, 7, 10 ** 9);
    expect(first).toContain("Full output saved");
    expect(second).toContain("Full output saved");
    // Backdate archives so the expiry path is deterministic.
    const dir = join(home, "tool-output-node");
    const old = new Date(Date.now() - 30 * 86_400_000);
    for (const name of await readdir(dir)) await utimes(join(dir, name), old, old);
    const pruned = await store.prune(7, 10 ** 9);
    expect(pruned.removed).toBeGreaterThanOrEqual(2);
    // Budget enforcement: keep newest under a tiny budget.
    await store.capture(big, 7, 10 ** 9);
    await store.capture(`${big}z`, 7, 10 ** 9);
    const budgeted = await store.prune(7, 10);
    expect(budgeted.removed).toBeGreaterThanOrEqual(1);
  });
});
