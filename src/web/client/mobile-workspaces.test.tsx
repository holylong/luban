import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { deleteMobileSession, loadDeviceWorkspaces, MobileWorkspaces, splitWorkspaces, workspaceLoadKey } from "./mobile-workspaces";
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
  it("reads every registered workspace but drops drafts that never got a message", async () => {
    const urls: URL[] = [];
    const fetcher = vi.fn(async (url: string | URL | Request) => {
      const parsed = new URL(String(url), "http://local");
      urls.push(parsed);
      if (parsed.pathname === "/api/node") return Response.json({ project: "one", workspace: "/work/one", projects: { two: "/work/two" } });
      const project = parsed.searchParams.get("project")!;
      return Response.json([summary(`${project}-draft`, project, 0), summary(`${project}-real`, project, 3)]);
    }) as unknown as typeof fetch;
    const entries = await loadDeviceWorkspaces("node & b", new AbortController().signal, fetcher);
    expect(entries.map(entry => entry.project)).toEqual(["one", "two"]);
    expect(entries.map(entry => entry.sessions.map(session => session.id))).toEqual([["one-real"], ["two-real"]]);
    expect(urls).toHaveLength(3);
    expect(urls.every(url => url.searchParams.get("node") === "node & b")).toBe(true);
    expect(urls[1]?.searchParams.get("limit")).toBe("200");
    // Every CLI start writes a system-prompt-only record, so asking the server
    // for drafts buried the real conversations under untitled rows in every
    // workspace the phone lists. The desktop session list hides them too.
    expect(urls.some(url => url.searchParams.has("includeEmpty"))).toBe(false);
  });

  it("keeps a running session that has no messages yet", async () => {
    const fetcher = vi.fn(async (url: string | URL | Request) => {
      const parsed = new URL(String(url), "http://local");
      return Response.json(parsed.pathname === "/api/node" ? { projects: { p: "/p" } } : [{ ...summary("live", "p", 0), running: true }]);
    }) as unknown as typeof fetch;
    const entries = await loadDeviceWorkspaces(undefined, new AbortController().signal, fetcher);
    expect(entries[0]?.sessions.map(session => session.id)).toEqual(["live"]);
  });

  it("skips probe workspaces a stale node still advertises", async () => {
    const urls: URL[] = [];
    const fetcher = vi.fn(async (url: string | URL | Request) => {
      const parsed = new URL(String(url), "http://local");
      urls.push(parsed);
      return Response.json(parsed.pathname === "/api/node"
        ? {
          project: "luban", workspace: "/Users/me/Documents/luban",
          projects: {
            luban: "/Users/me/Documents/luban",
            "luban-term-kKcgL5": "/private/var/folders/jw/T/luban-term-kKcgL5",
            "luban-a-uafP5D": "/private/var/folders/jw/T/luban-a-uafP5D",
            webapp: "/Users/me/Documents/webapp",
          },
        }
        : [summary("s", parsed.searchParams.get("project")!)]);
    }) as unknown as typeof fetch;
    const entries = await loadDeviceWorkspaces(undefined, new AbortController().signal, fetcher);
    expect(entries.map(entry => entry.project)).toEqual(["luban", "webapp"]);
    expect(urls.map(url => url.searchParams.get("project")).filter(Boolean)).toEqual(["luban", "webapp"]);
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

describe("workspace reload key", () => {
  const route = (project: string, nodeId = "n-a") => ({ project, path: `/work/${project}`, nodeId });
  it("ignores the fresh route array the relay poll hands over every few seconds", () => {
    // Two polls, two array objects, the same workspaces: the card must keep
    // what it already shows instead of blanking and re-folding the session list.
    const first = [route("cooler"), route("luban")];
    const second = [route("cooler"), route("luban")];
    expect(second).not.toBe(first);
    expect(workspaceLoadKey("n-a", 0, second)).toBe(workspaceLoadKey("n-a", 0, first));
  });
  it("also holds when a workspace moves to another instance of the same computer", () => {
    expect(workspaceLoadKey("n-a", 0, [route("cooler", "n-b")])).toBe(workspaceLoadKey("n-a", 0, [route("cooler", "n-a")]));
  });
  it("keeps physical-device inventory when representative and route order change", () => {
    expect(workspaceLoadKey("n-b", 0, [route("luban"), route("cooler", "n-b")], "machine"))
      .toBe(workspaceLoadKey("n-a", 0, [route("cooler"), route("luban")], "machine"));
  });
  it("still reloads for a real change: another device, a retry or a new workspace", () => {
    const base = workspaceLoadKey("n-a", 0, [route("cooler")]);
    expect(workspaceLoadKey("n-b", 0, [route("cooler")])).not.toBe(base);
    expect(workspaceLoadKey("n-a", 1, [route("cooler")])).not.toBe(base);
    expect(workspaceLoadKey("n-a", 0, [route("cooler"), route("luban")])).not.toBe(base);
  });
});

describe("workspace grouping", () => {
  const entry = (project: string, sessions: ReturnType<typeof summary>[], error?: string) => ({ project, path: `/work/${project}`, sessions, error });
  it("keeps workspaces with sessions in stable project order and folds empty ones", () => {
    const older = { ...summary("a", "alpha"), updatedAt: "2026-11-14T09:00:00Z" };
    const newer = { ...summary("b", "beta"), updatedAt: "2026-11-14T12:00:00Z" };
    const { active, idle } = splitWorkspaces([
      entry("idle", []), entry("alpha", [older]), entry("beta", [newer]), entry("documents", []),
    ]);
    expect(active.map(item => item.project)).toEqual(["alpha", "beta"]);
    expect(idle.map(item => item.project)).toEqual(["documents", "idle"]);
  });
  it("keeps the open workspace and read failures visible", () => {
    const { active, idle } = splitWorkspaces([entry("empty", []), entry("broken", [], "permission denied")], "empty");
    expect(active.map(item => item.project)).toEqual(["broken", "empty"]);
    expect(idle).toEqual([]);
  });
});
