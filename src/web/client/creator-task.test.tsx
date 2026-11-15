import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { RememberedApprovals, restoredComputer, TaskRow, timeline, type CreatorTask } from "./creator";

 describe("Creator turn conclusion", () => {
  const end = { type: "turn-end" as const, id: "t", ok: true, text: "已写入报告，并读回确认。", steps: 1, usage: { input: 0, output: 0, calls: 1 } };
  it("puts the authoritative answer after the last operation", () => {
    const items = timeline([
      { type: "turn-start", id: "t", text: "写报告" },
      { type: "text", text: "我来写报告" },
      { type: "tool", id: "a", name: "write_file", label: "写入报告" }, end,
    ]);
    expect(items.map(item => item.kind)).toEqual(["you", "action", "reply", "note"]);
    expect(items[2]).toMatchObject({ text: end.text, open: false });
    expect(items[3]).toMatchObject({ text: "本轮执行已结束" });
  });
  it("does not claim success when no answer was produced or execution failed", () => {
    expect(timeline([{ ...end, text: "" }]).at(-1)).toMatchObject({ text: expect.stringContaining("尚未确认") });
    expect(timeline([{ ...end, ok: false, stopReason: "max_steps" }]).at(-1)).toMatchObject({ tone: "error", text: expect.stringContaining("未完成") });
  });
  it("shows a finished task's conclusion without expanding it", () => {
    const task: CreatorTask = { id: "t", prompt: "写报告", workspace: "/work", at: 1, timeout: 1, status: "completed", result: "已生成报告，读回验证通过。" };
    const html = renderToStaticMarkup(<TaskRow task={task} now={2} onCancel={() => undefined} />);
    expect(html).toContain("执行结论");
    expect(html).toContain(task.result);
  });
});

/** A reminder row has to look different from a job row: it never runs a model. */
describe("Creator task row", () => {
  const base: CreatorTask = {
    id: "t1", prompt: "提醒我下班", workspace: "/tmp", at: Date.now(), timeout: 900_000, status: "queued",
  };

  it("marks a reminder with a 提醒 badge", () => {
    const html = renderToStaticMarkup(<TaskRow task={{ ...base, kind: "notify" }} now={Date.now()} onCancel={() => undefined} />);
    expect(html).toContain("提醒</span>");
    expect(html).toContain('class="kind"');
  });

  it("leaves an ordinary job without the badge", () => {
    const html = renderToStaticMarkup(<TaskRow task={{ ...base, kind: "agent" }} now={Date.now()} onCancel={() => undefined} />);
    expect(html).not.toContain('class="kind"');
  });
});

/** 授权 页要能看见并收回「已允许」的记忆，否则用户不知道什么还被记住了。 */
describe("Creator remembered approvals", () => {
  it("renders nothing when there is no standing approval", () => {
    expect(renderToStaticMarkup(<RememberedApprovals allowed={[]} onForget={() => undefined} />)).toBe("");
  });

  it("lists remembered tool names with a way to forget them", () => {
    const html = renderToStaticMarkup(<RememberedApprovals allowed={["computer", "bash"]} onForget={() => undefined} />);
    expect(html).toContain('aria-label="已记住的授权"');
    expect(html).toContain("computer、bash");
    expect(html).toContain("清空已记住的授权");
  });
});

/** 「打开操控」要记得上一次的选择，否则每次重启都像被悄悄关掉了。 */
describe("Creator restored computer switch", () => {
  it("keeps the persisted switch while the child is not running", () => {
    const state = restoredComputer({ ready: false, computer: { supported: true, enabled: false }, settings: { computer: true, allowed: [] } });
    expect(state.enabled).toBe(true);
    expect(state.supported).toBe(true);
  });

  it("trusts the live child once it reports", () => {
    const state = restoredComputer({ ready: true, computer: { supported: true, enabled: false }, settings: { computer: true, allowed: [] } });
    expect(state.enabled).toBe(false);
  });

  it("stays off when nothing was ever switched on", () => {
    expect(restoredComputer({ ready: false, computer: { supported: true } }).enabled).toBe(false);
  });
});
