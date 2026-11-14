import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { Memory, type CreatorMemory } from "./creator";

/**
 * OpenClaw's most quoted feature is that it remembers between conversations.
 * The window is where a wrong memory has to be visible and deletable, so these
 * cases pin what the 记忆 drawer shows and that every row has a way to go.
 */
describe("Creator memory drawer", () => {
  const row = (over: Partial<CreatorMemory> = {}): CreatorMemory => ({
    project: "luban",
    workspace: "/Users/me/luban",
    file: "/Users/me/.luban/memory/luban-1a2b3c4d.md",
    facts: [{ at: Date.parse("2026-11-14T09:00:00"), text: "禅道 bug 项目的 id 是 42" }],
    runs: [
      { at: Date.parse("2026-11-14T09:30:00"), text: "扫了本周新增 bug，找到 3 个。" },
      { at: Date.parse("2026-11-14T10:00:00"), text: "整理了过期截图。" },
    ],
    ...over,
  });

  it("shows facts and the run journal per project, with a way to clear", () => {
    const html = renderToStaticMarkup(<Memory rows={[row()]} onClose={() => undefined} onClear={() => undefined} />);
    expect(html).toContain("项目记忆");
    expect(html).toContain("禅道 bug 项目的 id 是 42");
    expect(html).toContain("扫了本周新增 bug");
    expect(html).toContain("/Users/me/luban");
    expect(html).toContain("清除这个项目的记忆");
    // Counts in the header, so "did it remember anything?" needs no scrolling.
    expect(html).toContain("1 个项目 · 事实 1 · 记录 2");
  });

  it("says so instead of showing an empty shell when nothing was kept", () => {
    const html = renderToStaticMarkup(<Memory rows={[]} onClose={() => undefined} onClear={() => undefined} />);
    expect(html).toContain("还没有任何记忆");
    expect(html).not.toContain("清除这个项目的记忆");
  });

  it("caps the journal rows so one chatty project cannot fill the drawer", () => {
    const runs = Array.from({ length: 9 }, (_, index) => ({ at: Date.parse("2026-11-14T10:00:00") + index * 60_000, text: `第 ${index} 次执行` }));
    const html = renderToStaticMarkup(<Memory rows={[row({ runs })]} onClose={() => undefined} onClear={() => undefined} />);
    expect(html).toContain("记录（最近 5 条）");
    expect(html).toContain("第 8 次执行");
    expect(html).not.toContain("第 3 次执行");
  });
});
