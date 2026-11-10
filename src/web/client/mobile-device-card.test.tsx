import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { MobileDeviceCard, type DeviceCardNode } from "./mobile-device-card";
import { deviceActivity } from "./mobile-device";

function node(fields: Partial<DeviceCardNode> = {}): DeviceCardNode {
  return {
    id: "node-a", name: "my-mac", workspace: "/Users/me/luban", online: true,
    status: { updated_at: 1, model: "deepseek-v4.1-flash", jobs: [], sessions: [] },
    ...fields,
  };
}

const render = (device: DeviceCardNode): string => renderToStaticMarkup(
  <MobileDeviceCard device={device} current={false} onOpen={() => undefined} onJobs={() => undefined} onRemove={() => undefined} />,
);

const session = (fields: Record<string, unknown> = {}) => ({
  id: "session-1", project: "luban", title: "整理右键菜单", updated_at: Math.round(Date.now() / 1000),
  ...fields,
});

const job = (fields: Record<string, unknown> = {}) => ({
  id: "job-1", title: "跑一遍测试", instruction: "跑一遍测试", status: "done", progress: 0, updated_at: 0,
  ...fields,
});

describe("device card", () => {
  it("shows a session the terminal is running as live work", () => {
    const html = render(node({ status: { updated_at: 1, jobs: [], sessions: [session()] } }));
    expect(html).toContain("正在工作");
    expect(html).toContain("整理右键菜单");
    expect(html).toContain("终端会话 · luban");
    // The bug: a busy terminal still reported an idle laptop.
    expect(html).not.toContain("空闲");
  });

  it("says idle only when nothing is running anywhere", () => {
    const html = render(node());
    expect(html).toContain("空闲，等待派活");
    expect(html).not.toContain("正在工作");
  });

  it("counts both terminal sessions and jobs as work in progress", () => {
    const html = render(node({
      status: { updated_at: 1, sessions: [session(), session({ id: "session-2", title: "第二个会话" })], jobs: [job({ status: "working" })] },
    }));
    expect(html).toContain("3 个进行中");
  });

  it("keeps the last job visible next to a running session", () => {
    const html = render(node({ status: { updated_at: 1, sessions: [session()], jobs: [job({ progress: 40, status: "working" })] } }));
    expect(html).toContain("整理右键菜单");
    expect(html).toContain("跑一遍测试");
    expect(html).toContain("进度 40%");
  });

  it("survives a node that reports no status at all", () => {
    const html = render(node({ status: undefined }));
    expect(html).toContain("空闲，等待派活");
    expect(html).not.toContain("正在工作");
    expect(render(node({ status: undefined, workspace: "" }))).toContain("未报告工作区");
  });

  it("hides a session that a now-offline laptop left behind", () => {
    // The relay keeps the last snapshot it saw; an offline node must not keep
    // claiming that its terminal is still working.
    const html = render(node({ online: false, status: { updated_at: 1, jobs: [], sessions: [session()] } }));
    expect(html).not.toContain("正在工作");
    expect(html).not.toContain("整理右键菜单");
    expect(html).toContain("离线");
  });

  it("offers removal only for an offline node", () => {
    expect(render(node({ online: false }))).toContain("移除");
    expect(render(node())).not.toContain("移除");
  });
});

describe("deviceActivity", () => {
  it("prefers live work over history when picking the headline", () => {
    const activity = deviceActivity({ updated_at: 1, jobs: [job({ id: "old" })], sessions: [session()] });
    expect(activity.running).toHaveLength(1);
    expect(activity.latest?.id).toBe("old");
  });

  it("falls back to the newest job when nothing is running", () => {
    const activity = deviceActivity({ updated_at: 1, jobs: [job({ id: "a" }), job({ id: "b" })] });
    expect(activity.running).toEqual([]);
    expect(activity.latest?.id).toBe("a");
    expect(deviceActivity(undefined).latest).toBeUndefined();
  });
});
