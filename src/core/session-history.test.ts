import { describe, expect, it } from "vitest";
import { mkdtemp, readFile, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SessionHistory } from "./session-history.js";
import { SessionStore } from "./session-store.js";
import type { ChatMessage, HistorySettings, SessionRecord } from "./types.js";

const settings = (overrides: Partial<HistorySettings> = {}): HistorySettings =>
  ({ enabled: true, directory: "", maxMessagesPerSession: 0, ...overrides });

async function home(): Promise<string> {
  return mkdtemp(join(tmpdir(), "luban-history-"));
}

function record(store: SessionStore, messages: ChatMessage[] = []): SessionRecord {
  const created = store.create("demo", store.root, "agent", "test/model", messages);
  created.messages = messages;
  return created;
}

describe("SessionHistory", () => {
  it("mirrors a session as its messages are appended and reloads from the database", async () => {
    const directory = await home();
    const opened = SessionHistory.open(settings({ directory }), directory);
    expect(opened).toBeDefined();

    const store = new SessionStore(directory, opened);
    const session = record(store, [{ role: "user", content: "first" }]);
    await store.save(session);
    expect(opened!.count(session.id)).toBe(1);

    // The mirror is a side record: the JSON stays the authoritative copy.
    const stored = JSON.parse(await readFile(join(directory, "sessions-node", "demo", `${session.id}.json`), "utf8")) as SessionRecord;
    expect(stored.messages).toHaveLength(1);

    session.messages.push({ role: "assistant", content: "second" }, { role: "user", content: "third" });
    await store.save(session);
    expect(opened!.count(session.id)).toBe(3);
    expect(opened!.messages(session.id).map((message) => message.content)).toEqual(["first", "second", "third"]);
    opened!.close();

    // A second process sees the stored window and only adds what is new.
    const reopened = SessionHistory.open(settings({ directory }), directory);
    expect(reopened!.append(session)).toBe(0);
    session.messages.push({ role: "assistant", content: "fourth" });
    expect(reopened!.append(session)).toBe(1);
    expect(reopened!.messages(session.id)).toHaveLength(4);
    reopened!.close();
  });

  it("re-mirrors from the start when compaction or a branch cut the list", async () => {
    const directory = await home();
    const history = SessionHistory.open(settings({ directory }), directory)!;
    const store = new SessionStore(directory, history);
    const session = record(store, [
      { role: "system", content: "sys" },
      { role: "user", content: "old question" },
      { role: "assistant", content: "old answer" },
      { role: "user", content: "new question" },
    ]);
    await store.save(session);
    expect(history.count(session.id)).toBe(4);

    // What context compaction does: the old exchange is summarized away.
    session.messages = [session.messages[0]!, { role: "assistant", content: "summary of the old exchange" }, session.messages[3]!];
    await store.save(session);
    expect(history.messages(session.id).map((message) => message.content)).toEqual(["sys", "summary of the old exchange", "new question"]);
  });

  it("drops the oldest rows once a session outgrows the configured window", async () => {
    const directory = await home();
    const history = SessionHistory.open(settings({ directory, maxMessagesPerSession: 3 }), directory)!;
    const store = new SessionStore(directory, history);
    const session = record(store, [{ role: "user", content: "m0" }]);
    for (let index = 1; index < 7; index += 1) {
      session.messages.push({ role: "assistant", content: `m${index}` });
      await store.save(session);
    }
    expect(history.count(session.id)).toBe(3);
    expect(history.messages(session.id).map((message) => message.content)).toEqual(["m4", "m5", "m6"]);
    history.close();
  });

  it("searches stored messages and escapes LIKE wildcards in the query", async () => {
    const directory = await home();
    const history = SessionHistory.open(settings({ directory }), directory)!;
    const store = new SessionStore(directory, history);
    const session = record(store, [
      { role: "user", content: "how does the mesh relay authenticate?" },
      { role: "assistant", content: "100%" },
    ]);
    await store.save(session);
    expect(history.search("relay").map((hit) => hit.seq)).toEqual([0]);
    // A bare `%` must be a literal percent, not a wildcard that matches everything.
    expect(history.search("%").map((hit) => hit.seq)).toEqual([1]);
    expect(history.search("relay")[0]!.sessionId).toBe(session.id);
    history.close();
  });

  it("lists mirrored sessions by recency and filters them by project", async () => {
    const directory = await home();
    const history = SessionHistory.open(settings({ directory }), directory)!;
    const store = new SessionStore(directory, history);
    const first = record(store, [{ role: "user", content: "older" }]);
    await store.save(first);
    const second = store.create("other", directory, "agent", "test/model", [{ role: "user", content: "newer" }]);
    await store.save(second);

    const listed = history.sessions();
    expect(listed.map((session) => session.id)).toEqual([second.id, first.id]);
    expect(listed.map((session) => session.messages)).toEqual([1, 1]);
    expect(listed[0]!.project).toBe("other");
    expect(history.sessions("demo").map((session) => session.id)).toEqual([first.id]);
    expect(history.sessions("absent")).toEqual([]);
    history.close();
  });

  it("reads an existing database without enabling the writer", async () => {
    const directory = await home();
    const writer = SessionHistory.open(settings({ directory }), directory)!;
    const store = new SessionStore(directory, writer);
    const session = record(store, [{ role: "user", content: "hello history" }]);
    await store.save(session);
    writer.close();

    expect(SessionHistory.openForRead(settings({ enabled: false, directory }), directory)?.search("hello")[0]!.sessionId).toBe(session.id);
    const elsewhere = await home();
    expect(SessionHistory.openForRead(settings({ directory: "" }), elsewhere)).toBeUndefined();
  });

  it("stays off when disabled and writes nothing to disk", async () => {
    const directory = await home();
    expect(SessionHistory.open(settings({ enabled: false }), directory)).toBeUndefined();
    const store = new SessionStore(directory);
    const session = record(store, [{ role: "user", content: "hello" }]);
    await store.save(session);
    expect(await readdir(directory)).toEqual(["sessions-node"]);
  });
});
