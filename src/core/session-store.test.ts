import { describe, expect, it } from "vitest";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SessionStore } from "./session-store.js";
import type { ChatMessage } from "./types.js";

describe("SessionStore", () => {
  it("re-derives a title that came from the opening user line but keeps a model-written one", async () => {
    const home = await mkdtemp(join(tmpdir(), "luban-title-"));
    const store = new SessionStore(home);
    const record = store.create("demo", home, "auto", "local/coder", []);
    record.messages.push({ role: "user", content: "继续" }, { role: "assistant", content: "已按上次的结论继续。" });
    await store.save(record);
    expect(record.titleSource).toBe("auto");
    expect(record.title).toBe("继续");

    // What the naming round trip writes. Saving again — which happens after
    // every step of every later run — must not put the raw "继续" back.
    record.title = "修复解析器内存泄漏";
    record.titleSource = "model";
    await store.save(record);
    record.messages.push({ role: "user", content: "继续" });
    await store.save(record);
    const stored = await store.load(record.id, "demo");
    expect(stored?.title).toBe("修复解析器内存泄漏");
    expect(stored?.titleSource).toBe("model");
  });

  it("does not save empty drafts and resumes a meaningful session", async () => {
    const home = await mkdtemp(join(tmpdir(), "luban-session-"));
    const store = new SessionStore(home);
    const system: ChatMessage[] = [{ role: "system", content: "system" }];
    const draft = store.create("demo", home, "auto", "local/coder", system);
    await store.save(draft);
    expect(await store.list()).toEqual([]);

    draft.messages.push({ role: "user", content: "fix the parser" });
    await store.save(draft);
    const latest = await store.load("latest", "demo");
    expect(latest?.id).toBe(draft.id);
    expect(latest?.title).toBe("fix the parser");
  });

  it("forks a session and repairs cuts inside tool batches", async () => {
    const home = await mkdtemp(join(tmpdir(), "luban-branch-"));
    const store = new SessionStore(home);
    const source = store.create("demo", home, "agent", "local/coder", [
      { role: "system", content: "sys" },
      { role: "user", content: "do it" },
      { role: "assistant", content: "", tool_calls: [{ id: "c1", type: "function", function: { name: "bash", arguments: "{}" } }] },
      { role: "tool", name: "bash", tool_call_id: "c1", content: "ok" },
      { role: "assistant", content: "done" },
    ]);
    const full = store.branch(source);
    expect(full.id).not.toBe(source.id);
    expect(full.title).toContain("(branch)");
    expect(full.messages).toHaveLength(5);
    // Cut between the tool call and its result: repair marks it interrupted.
    const cut = store.branch(source, 2);
    expect(cut.messages.filter((message) => message.role === "system" && !message.tool_calls)).toHaveLength(1);
    const repaired = cut.messages.find((message) => message.role === "tool");
    expect(String(repaired?.content)).toMatch(/interrupted/);
    await store.save(full);
    expect(await store.load(full.id, "demo")).toMatchObject({ id: full.id });
  });
});
