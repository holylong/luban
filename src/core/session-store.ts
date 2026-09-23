import { mkdir, readFile, readdir, rename, rm, stat, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { basename, join, resolve } from "node:path";
import type { AgentMode, ChatMessage, SessionRecord } from "./types.js";
import { repairToolHistory } from "./history.js";

function safeName(value: string): string {
  const cleaned = value.replace(/[^a-zA-Z0-9._-]+/g, "-").replace(/^-+|-+$/g, "");
  return cleaned || "default";
}

function newId(): string {
  const stamp = new Date().toISOString().replace(/[-:TZ.]/g, "").slice(0, 14);
  return `${stamp}-${Math.random().toString(36).slice(2, 8)}`;
}

function titleFrom(messages: ChatMessage[]): string {
  const first = messages.find((message) => message.role === "user" && message.content?.trim());
  return (first?.content ?? "New session").trim().split("\n")[0]!.slice(0, 80);
}

export class SessionStore {
  readonly root: string;
  private static readonly writes = new Map<string, Promise<void>>();

  constructor(home: string) {
    this.root = join(home, "sessions-node");
  }

  create(project: string, workspace: string, mode: AgentMode, model: string, messages: ChatMessage[]): SessionRecord {
    const now = new Date().toISOString();
    return {
      id: newId(),
      title: titleFrom(messages),
      project: project || basename(workspace) || "default",
      workspace,
      mode,
      model,
      createdAt: now,
      updatedAt: now,
      messages,
    };
  }

  private path(record: Pick<SessionRecord, "project" | "id">): string {
    return join(this.root, safeName(record.project), `${safeName(record.id)}.json`);
  }

  async save(record: SessionRecord): Promise<void> {
    const edits = new Map((record.edits || []).map(edit => [edit.id, edit]));
    for (const message of record.messages) if (message.editPreview && message.tool_call_id) {
      edits.set(message.tool_call_id, { id: message.tool_call_id, name: message.name || "edit_file", preview: message.editPreview });
    }
    if (edits.size) record.edits = [...edits.values()];
    const meaningful = record.messages.some((message) => message.role !== "system");
    if (!meaningful && !record.pendingInputs?.length) return;
    record.title = titleFrom(record.messages);
    record.updatedAt = new Date().toISOString();
    const path = this.path(record);
    // Capture the admitted state now, then commit snapshots in call order.
    const body = `${JSON.stringify(record, null, 2)}\n`;
    const write = (SessionStore.writes.get(path) ?? Promise.resolve()).catch(() => undefined).then(async () => {
      await mkdir(join(this.root, safeName(record.project)), { recursive: true });
      const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`;
      try {
        await writeFile(temporary, body, { encoding: "utf8", mode: 0o600 });
        await rename(temporary, path);
      } finally { await rm(temporary, { force: true }).catch(() => undefined); }
    });
    SessionStore.writes.set(path, write);
    try { await write; } finally {
      if (SessionStore.writes.get(path) === write) SessionStore.writes.delete(path);
    }
  }

  /** Fork a session, keeping the first `keep` non-system messages (default all).
   * A cut inside a tool batch is repaired with explicit interrupted markers. */
  branch(source: SessionRecord, keep = Number.POSITIVE_INFINITY): SessionRecord {
    const systems = source.messages.filter((message) => message.role === "system" && !message.tool_calls);
    const conversation = source.messages.filter((message) => message.role !== "system" || message.tool_calls);
    const sliced = conversation.slice(0, Math.max(0, Math.min(conversation.length, Math.trunc(keep))));
    const messages = [...structuredClone(systems), ...structuredClone(sliced)];
    repairToolHistory(messages);
    const now = new Date().toISOString();
    return {
      ...structuredClone(source),
      id: newId(),
      title: `${source.title} (branch)`.slice(0, 80),
      messages,
      pendingInputs: [],
      createdAt: now,
      updatedAt: now,
    };
  }

  async load(reference: string, project?: string, workspace?: string): Promise<SessionRecord | undefined> {
    const entries = await this.list(project, workspace);
    const selected = reference === "latest"
      ? entries[0]
      : entries.find((entry) => entry.id === reference || entry.id.startsWith(reference));
    if (!selected) return undefined;
    try {
      return JSON.parse(await readFile(this.path(selected), "utf8")) as SessionRecord;
    } catch {
      return undefined;
    }
  }

  async list(project?: string, workspace?: string): Promise<SessionRecord[]> {
    let projectNames: string[] = [];
    try {
      projectNames = project ? [safeName(project)] : await readdir(this.root);
    } catch {
      return [];
    }
    const records: SessionRecord[] = [];
    for (const projectName of projectNames) {
      const directory = join(this.root, projectName);
      let names: string[] = [];
      try {
        names = (await readdir(directory)).filter((name) => name.endsWith(".json"));
      } catch {
        continue;
      }
      for (const name of names) {
        try {
          const path = join(directory, name);
          const data = JSON.parse(await readFile(path, "utf8")) as SessionRecord;
          if (workspace && (typeof data.workspace !== "string" || resolve(data.workspace) !== resolve(workspace))) continue;
          const info = await stat(path);
          data.updatedAt ||= info.mtime.toISOString();
          records.push(data);
        } catch {
          // Ignore half-written or old incompatible session files.
        }
      }
    }
    return records.sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
  }
}
