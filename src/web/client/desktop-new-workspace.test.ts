import { createRequire } from "node:module";
import { mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it, vi } from "vitest";
const { chooseNewWorkspace } = createRequire(import.meta.url)("../../../apps/desktop/new-workspace.cjs");

it("creates a new directory using the parented native dialog", async () => {
  const root = await mkdtemp(join(tmpdir(), "luban-new-workspace-"));
  try {
    const target = join(root, "项目");
    const dialog = { showSaveDialog: vi.fn().mockResolvedValue({ filePath: target }) };
    const win = {};
    expect(await chooseNewWorkspace(dialog, win, root)).toBe(target);
    expect((await stat(target)).isDirectory()).toBe(true);
    expect(dialog.showSaveDialog).toHaveBeenCalledWith(win, expect.objectContaining({ buttonLabel: "创建工作区" }));
    await expect(chooseNewWorkspace(dialog, win, root)).rejects.toThrow("已存在");
    const file = join(root, "file");
    await writeFile(file, "keep");
    dialog.showSaveDialog.mockResolvedValue({ filePath: file });
    await expect(chooseNewWorkspace(dialog, win, root)).rejects.toThrow("已存在");
  } finally { await rm(root, { recursive: true, force: true }); }
});

it("does not create anything when canceled", async () => {
  const dialog = { showSaveDialog: vi.fn().mockResolvedValue({ canceled: true }) };
  expect(await chooseNewWorkspace(dialog, undefined, tmpdir())).toBeUndefined();
});

it("propagates filesystem failures", async () => {
  const root = await mkdtemp(join(tmpdir(), "luban-new-workspace-"));
  try {
    const dialog = { showSaveDialog: vi.fn().mockResolvedValue({ filePath: join(root, "missing", "child") }) };
    await expect(chooseNewWorkspace(dialog, undefined, root)).rejects.toMatchObject({ code: "ENOENT" });
  } finally { await rm(root, { recursive: true, force: true }); }
});
