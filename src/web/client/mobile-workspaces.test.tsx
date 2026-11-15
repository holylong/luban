import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { deleteMobileSession, loadDeviceWorkspaces, MobileWorkspaces } from "./mobile-workspaces";
import { MobileDeviceCard } from "./mobile-device-card";

const summary = (id: string, project: string, messages = 2) => ({
  id, project, title: id, workspace: `/work/${project}`, messages,
  createdAt: "2026-11-14T10:00:00Z", updatedAt: "2026-11-14T11:00:00Z",
  model: "test", mode: "agent", edits: 0,
});

describe("mobile session deletion", () => {
  it("requires confirmation and blocks known running sessions without a request", async () => {
    const fetcher = vi.fn();
    const confirm = vi.fn(() => false);
    expect(await deleteMobileSession("b", summary("s", "cooler"), confirm, fetcher)).toBe(false);
    expect(confirm).toHaveBeenCalledWith(expect.stringContaining("不会删除工作区文件"));
    expect(await deleteMobileSession("b", { ...summary("s", "cooler"), running: true }, confirm, fetcher)).toBe(false);
    expect(confirm).toHaveBeenCalledTimes(1);
    expect(fetcher).not.toHaveBeenCalled();
  });
  it("deletes using the explicit device, project and exact id", async () => {
    const fetcher = vi.fn(async (_url: string | URL | Request, _init?: RequestInit) => Response.json({ ok: true }));
    expect(await deleteMobileSession("b & c", summary("s/1", "cooler"), () => true, fetcher)).toBe(true);
    const url = new URL(String(fetcher.mock.calls[0]![0]), "http://local");
    expect(url.pathname).toBe("/api/sessions/s%2F1/delete");
    expect(url.searchParams.get("node")).toBe("b & c");
    expect(url.searchParams.get("project")).toBe("cooler");
  });
  it("reports server protection when a session starts running after inventory", async () => {
    await expect(deleteMobileSession("b", summary("s", "cooler"), () => true,
      vi.fn(async () => Response.json({ error: "session is running" }, { status: 409 })))).rejects.toThrow("session is running");
  });
});

describe("device workspace inventory", () => {
  it("reads every registered workspace, including empty sessions, not relay status", async () => {
    const urls: URL[] = [];
    const fetcher = vi.fn(async (url: string | URL | Request) => {
      const parsed = new URL(String(url), "http://local");
      urls.push(parsed);
      return Response.json(parsed.pathname === "/api/node"
        ? { project: "one", workspace: "/work/one", projects: { two: "/work/two" } }
        : [summary("same-id", parsed.searchParams.get("project")!, 0)]);
    }) as unknown as typeof fetch;
    const entries = await loadDeviceWorkspaces("node & b", new AbortController().signal, fetcher);
    expect(entries.map(entry => entry.project)).toEqual(["one", "two"]);
    expect(entries.map(entry => entry.sessions[0]?.project)).toEqual(["one", "two"]);
    expect(entries[1]?.sessions[0]?.messages).toBe(0);
    expect(urls).toHaveLength(3);
    expect(urls.every(url => url.searchParams.get("node") === "node & b")).toBe(true);
    expect(urls[1]?.searchParams.get("limit")).toBe("200");
  });

  it("does not let one unreadable project's sessions hide the others", async () => {
    const fetcher = vi.fn(async (url: string | URL | Request) => {
      const parsed = new URL(String(url), "http://local");
      if (parsed.pathname === "/api/node") return Response.json({ projects: { a: "/a", b: "/b" } });
      return parsed.searchParams.get("project") === "a"
        ? Response.json({ error: "permission denied" }, { status: 403 }) : Response.json([summary("b-session", "b")]);
    }) as unknown as typeof fetch;
    const entries = await loadDeviceWorkspaces(undefined, new AbortController().signal, fetcher);
    expect(entries[0]?.error).toBe("permission denied");
    expect(entries[1]?.sessions[0]?.id).toBe("b-session");
  });

  it("keeps simultaneous device reads isolated", async () => {
    const fetcher = vi.fn(async (url: string | URL | Request) => {
      const parsed = new URL(String(url), "http://local");
      await new Promise(resolve => setTimeout(resolve, parsed.searchParams.get("node") === "a" ? 5 : 0));
      return Response.json(parsed.pathname === "/api/node" ? { projects: { p: "/p" } }
        : [summary(parsed.searchParams.get("node")!, "p")]);
    }) as unknown as typeof fetch;
    const [a, b] = await Promise.all(["a", "b"].map(node => loadDeviceWorkspaces(node, new AbortController().signal, fetcher)));
    expect(a?.[0]?.sessions[0]?.id).toBe("a");
    expect(b?.[0]?.sessions[0]?.id).toBe("b");
  });

  it("reports failed inventory instead of silently showing no workspaces", async () => {
    await expect(loadDeviceWorkspaces("offline", new AbortController().signal,
      vi.fn(async () => Response.json({ error: "offline" }, { status: 502 })) as typeof fetch)).rejects.toThrow("offline");
  });

  it("passes the abort signal and does not disguise cancellation as an empty project", async () => {
    const controller = new AbortController();
    const fetcher = vi.fn(async (_url: unknown, init?: RequestInit) => {
      expect(init?.signal).toBe(controller.signal);
      controller.abort();
      throw new DOMException("Aborted", "AbortError");
    }) as typeof fetch;
    await expect(loadDeviceWorkspaces("a", controller.signal, fetcher)).rejects.toThrow("Aborted");
  });
});

it("puts the workspace entry inside the device, not behind the old generic open button", () => {
  const html = renderToStaticMarkup(<MobileDeviceCard device={{ id: "a", name: "Laptop", workspace: "/a", online: true }}
    current onOpen={() => {}} onJobs={() => {}} onRemove={() => {}}>
    <MobileWorkspaces nodeId="a" online onOpen={() => {}} onAdd={() => {}} />
  </MobileDeviceCard>);
  expect(html).toContain("工作区与会话");
  expect(html).toContain("新建工作区");
  expect(html).not.toContain("打开并派活");
});

it("explains offline devices without presenting stale sessions as live entry points", () => {
  const html = renderToStaticMarkup(<MobileWorkspaces nodeId="a" online={false} onOpen={() => {}} onAdd={() => {}} />);
  expect(html).toContain("电脑离线");
  expect(html).toContain("disabled");
  expect(html).not.toContain("正在读取");
});
