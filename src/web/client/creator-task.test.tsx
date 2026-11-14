import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { RememberedApprovals, restoredComputer, TaskRow, type CreatorTask } from "./creator";

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
