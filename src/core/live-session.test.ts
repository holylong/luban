import { describe, expect, it } from "vitest";
import { LiveSessionRegistry } from "./live-session.js";
import { SessionStore } from "./session-store.js";

function session() {
  return new SessionStore("/tmp/live-test").create("project", "/workspace", "agent", "model", [
    { role: "system", content: "system" }, { role: "user", content: "question" },
  ]);
}

describe("LiveSessionRegistry", () => {
  it("clones initial snapshots, freezes running messages, and publishes the final history", () => {
    const registry = new LiveSessionRegistry();
    const record = session();
    registry.publish("/home/a", record);
    record.title = "changed";
    expect(registry.get("/home/a", record.project, record.id)?.session.title).not.toBe("changed");
    registry.start("/home/a", record);
    record.messages.push({ role: "assistant", content: "answer" });
    registry.publish("/home/a", record);
    registry.append("/home/a", record.project, record.id, { kind: "delta", text: "answer" });
    const running = registry.get("/home/a", record.project, record.id)!;
    expect(running).toMatchObject({ running: true, baseMessageCount: 2 });
    expect(running.session.messages).toHaveLength(2);
    expect(running.events).toMatchObject([{ seq: 1, event: { kind: "delta", text: "answer" } }]);
    expect(running.events[0]!.at).toBeGreaterThan(1_000_000_000);
    running.events.length = 0;
    running.session.messages.length = 0;
    expect(registry.get("/home/a", record.project, record.id)?.events).toHaveLength(1);
    registry.finish("/home/a", record);
    registry.append("/home/a", record.project, record.id, { kind: "delta", text: "late" });
    expect(registry.get("/home/a", record.project, record.id)).toMatchObject({
      running: false, events: [], baseMessageCount: 3, session: { messages: record.messages },
    });
    registry.start("/home/a", record);
    expect(registry.get("/home/a", record.project, record.id)?.events).toEqual([]);
  });

  it("isolates homes and projects, and removes only the requested snapshot", () => {
    const registry = new LiveSessionRegistry();
    const record = session();
    registry.start("/home/a", record);
    expect(registry.get("/home/b", record.project, record.id)).toBeUndefined();
    expect(registry.list("/home/a", "other")).toEqual([]);
    expect(registry.list("/home/b", record.project)).toEqual([]);
    const list = registry.list("/home/a", record.project);
    list[0]!.session.title = "mutated";
    expect(registry.get("/home/a", record.project, record.id)?.session.title).not.toBe("mutated");
    registry.remove("/home/b", record.project, record.id);
    expect(registry.list("/home/a", record.project)).toHaveLength(1);
    registry.remove("/home/a", record.project, record.id);
    expect(registry.list("/home/a", record.project)).toEqual([]);
  });

  it("coalesces thousands of deltas without losing text or merging different kinds", () => {
    const registry = new LiveSessionRegistry();
    const record = session();
    registry.start("/home/a", record);
    for (const kind of ["thinking", "delta"] as const) {
      for (let i = 0; i < 5000; i++) registry.append("/home/a", record.project, record.id, { kind, text: `片段${i}\n` });
    }
    const events = registry.get("/home/a", record.project, record.id)!.events;
    expect(events.length).toBeLessThan(10);
    for (const kind of ["thinking", "delta"] as const) {
      expect(events.filter(item => item.event.kind === kind).map(item => "text" in item.event ? item.event.text : "").join(""))
        .toBe(Array.from({ length: 5000 }, (_, i) => `片段${i}\n`).join(""));
    }
    expect(events.at(-1)!.seq).toBe(10000);
  });

  it("checkpoints completed output and accepted input atomically without duplicate replay", () => {
    const registry = new LiveSessionRegistry();
    const record = session();
    registry.start("/home/a", record);
    registry.append("/home/a", record.project, record.id, { kind: "delta", text: "completed" });
    record.messages.push({ role: "assistant", content: "completed" }, { role: "user", content: "steered input" });
    registry.checkpoint("/home/a", record);
    registry.publish("/home/a", record);
    let snapshot = registry.get("/home/a", record.project, record.id)!;
    expect(snapshot.events).toEqual([]);
    expect(snapshot.baseMessageCount).toBe(4);
    expect(snapshot.session.messages).toEqual(record.messages);
    // Even if the bounded replay trims heavily, the latest durable history stays.
    for (let i = 0; i < 1250; i++) registry.append("/home/a", record.project, record.id, { kind: "status", text: String(i) });
    snapshot = registry.get("/home/a", record.project, record.id)!;
    expect(snapshot.session.messages).toEqual(record.messages);
    expect(snapshot.events[0]!.seq).toBe(52);
    registry.checkpoint("/home/a", record);
    registry.append("/home/a", record.project, record.id, { kind: "delta", text: "next answer" });
    snapshot = registry.get("/home/a", record.project, record.id)!;
    expect(snapshot.events).toMatchObject([{ seq: 1252, event: { text: "next answer" } }]);
    record.messages[2]!.content = "mutated";
    expect(snapshot.session.messages[2]!.content).toBe("completed");
    expect(registry.get("/home/a", record.project, record.id)!.session.messages[2]!.content).toBe("completed");
  });

  it("prunes old inactive snapshots without removing active runs", () => {
    const registry = new LiveSessionRegistry();
    const active = session();
    registry.start("/home/a", active);
    for (let i = 0; i < 70; i++) registry.publish("/home/a", { ...session(), id: `inactive-${i}` });
    expect(registry.list("/home/a", active.project)).toHaveLength(65);
    expect(registry.get("/home/a", active.project, active.id)?.running).toBe(true);
    expect(registry.get("/home/a", active.project, "inactive-0")).toBeUndefined();
    expect(registry.get("/home/a", active.project, "inactive-69")).toBeDefined();
  });

  it("bounds event count and bytes while preserving monotonic tail sequence numbers", () => {
    const registry = new LiveSessionRegistry();
    const record = session();
    registry.start("/home/a", record);
    for (let i = 0; i < 1250; i++) registry.append("/home/a", record.project, record.id, { kind: "status", text: String(i) });
    let events = registry.get("/home/a", record.project, record.id)!.events;
    expect(events).toHaveLength(1200);
    expect(events[0]!.seq).toBe(51);
    expect(events.at(-1)!.seq).toBe(1250);
    for (let i = 0; i < 10; i++) registry.append("/home/a", record.project, record.id, { kind: "delta", text: "x".repeat(300_000) });
    registry.append("/home/a", record.project, record.id, { kind: "delta", text: "x".repeat(3_000_000) });
    events = registry.get("/home/a", record.project, record.id)!.events;
    expect(Buffer.byteLength(JSON.stringify(events))).toBeLessThan(2 * 1024 * 1024);
    expect(events.at(-1)!.seq).toBe(1260);
  });
});
