import type React from "react";
import { afterEach, expect, it, vi } from "vitest";
import { isFileLink, openConversationLink, workspaceLink } from "./conversation-links";
import type { WorkbenchStore } from "./store";

afterEach(() => vi.unstubAllGlobals());
function click(href: string, file?: string) {
  const anchor = { getAttribute: () => href, dataset: { filePath: file } };
  return { target: { closest: () => anchor }, preventDefault: vi.fn() } as unknown as React.MouseEvent;
}
const makeStore = () => ({ project: "p", node: { projects: { p: "/work" } }, notify: vi.fn(), openFile: vi.fn().mockResolvedValue(undefined) }) as unknown as WorkbenchStore;
it("opens HTTP links through the desktop bridge and not the renderer", async () => {
  const openExternal = vi.fn().mockResolvedValue({ ok: true });
  vi.stubGlobal("window", { lubanDesktop: { openExternal } });
  const event = click("https://example.com/a?q=1");
  await openConversationLink(event, makeStore());
  expect(event.preventDefault).toHaveBeenCalled();
  expect(openExternal).toHaveBeenCalledWith("https://example.com/a?q=1");
});
it("keeps normal new-tab behavior in a browser", async () => {
  vi.stubGlobal("window", {});
  const event = click("https://example.com");
  await openConversationLink(event, makeStore());
  expect(event.preventDefault).not.toHaveBeenCalled();
});
it("opens relative and absolute workspace file links via the OS", async () => {
  const openPath = vi.fn().mockResolvedValue({ ok: true });
  vi.stubGlobal("window", { lubanDesktop: { openPath } });
  await openConversationLink(click("#", "/work/src/a.ts:42:3"), makeStore());
  expect(openPath).toHaveBeenCalledWith("src/a.ts");
  expect(workspaceLink("file:///work/docs/a%20b.pdf#L2", "/work")).toBe("docs/a b.pdf");
});
it("rejects outside-project and traversal links and reports opening errors", async () => {
  const openPath = vi.fn().mockRejectedValue(new Error("missing file"));
  vi.stubGlobal("window", { lubanDesktop: { openPath } });
  const store = makeStore();
  await openConversationLink(click("#", "/work-other/a.ts"), store);
  expect(openPath).not.toHaveBeenCalled();
  expect(store.notify).toHaveBeenCalledWith("只能打开当前项目内的文件", true);
  expect(() => workspaceLink("../secret", "/work")).toThrow();
  await openConversationLink(click("#", "a.ts"), store);
  expect(store.notify).toHaveBeenCalledWith("missing file", true);
});
it("recognizes file references without turning code expressions into paths", () => {
  for (const path of ["src/a.ts", "/work/a.ts:12", "./docs/说明.md", "package.json"]) expect(isFileLink(path)).toBe(true);
  for (const code of ["javascript:alert(1)", "data:text/html,hi", "POST /match", "a + b", "https://a"]) expect(isFileLink(code)).toBe(false);
});
