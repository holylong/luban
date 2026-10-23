import { mkdir, readFile, readdir, rename, rm, stat, writeFile } from "node:fs/promises";
import { createHash, randomUUID } from "node:crypto";
import { basename, join, resolve } from "node:path";
import type { AgentMode, ChatMessage, SessionRecord } from "./types.js";
import type { SessionHistory } from "./session-history.js";
import { repairToolHistory } from "./history.js";
import { fallbackTitle, MAX_TITLE_LENGTH } from "./session-title.js";
import { withSessionLock } from "./session-lock.js";

function fingerprint(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

function progress(record: SessionRecord): string {
  const edits = new Map((record.edits ?? []).map(edit => [edit.id, edit]));
  for (const message of record.messages) if (message.editPreview && message.tool_call_id) {
    edits.set(message.tool_call_id, { id: message.tool_call_id, name: message.name || "edit_file", preview: message.editPreview });
  }
  return fingerprint([record.messages, record.pendingInputs ?? [], [...edits.values()]]);
}

interface SavedState { token: string | null; progress: string }

export class SessionConflictError extends Error {
  constructor(id: string) {
    super(`会话已由另一终端更新，已阻止旧进度覆盖。请用 luban --resume ${id} 重新打开后继续。`);
    this.name = "SessionConflictError";
  }
}

function safeName(value: string): string {
  const cleaned = value.replace(/[^a-zA-Z0-9._-]+/g, "-").replace(/^-+|-+$/g, "");
  return cleaned || "default";
}

function newId(): string {
  const stamp = new Date().toISOString().replace(/[-:TZ.]/g, "").slice(0, 14);
  return `${stamp}-${Math.random().toString(36).slice(2, 8)}`;
}

export class SessionStore {
  readonly root: string;
  private static readonly writes = new Map<string, Promise<void>>();
  private static readonly states = new WeakMap<SessionRecord, SavedState>();

  private remember(record: SessionRecord, token: string | null = fingerprint(record)): SessionRecord {
    SessionStore.states.set(record, { token, progress: progress(record) });
    return record;
  }

  private async read(path: string): Promise<SessionRecord | undefined> {
    try { return JSON.parse(await readFile(path, "utf8")) as SessionRecord; } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
      throw error;
    }
  }

  /**
   * @param home luban home directory holding the session records.
   * @param history Queryable mirror kept in step with every save; omit it to
   *   leave session history in JSON only.
   */
  constructor(home: string, private readonly history?: SessionHistory) {
    this.root = join(home, "sessions-node");
  }

  create(project: string, workspace: string, mode: AgentMode, model: string, messages: ChatMessage[]): SessionRecord {
    const now = new Date().toISOString();
    return this.remember({
      id: newId(),
      title: fallbackTitle(messages),
      titleSource: "auto",
      project: project || basename(workspace) || "default",
      workspace,
      mode,
      model,
      createdAt: now,
      updatedAt: now,
      messages,
    }, null);
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
    if (!meaningful && !record.pendingInputs?.length && !record.inputHistory?.length) return;
    // Only a derived title is re-derived. A title the model wrote is the whole
    // point of the naming round trip, and recomputing it here would replace it
    // with the raw opening line on the very next save.
    if (record.titleSource !== "model") record.title = fallbackTitle(record.messages);
    const path = this.path(record);
    // Capture content at admission, but compare against the last committed state
    // inside the lock. Queued saves of the same live object share that baseline.
    const snapshot = structuredClone(record);
    let state = SessionStore.states.get(record);
    if (!state) {
      state = { token: fingerprint(record), progress: progress(record) };
      SessionStore.states.set(record, state);
    }
    const baseline = state;
    const nextProgress = progress(snapshot);
    const write = (SessionStore.writes.get(path) ?? Promise.resolve()).catch(() => undefined).then(async () => {
      await mkdir(join(this.root, safeName(snapshot.project)), { recursive: true });
      await withSessionLock(path, async () => {
        const current = await this.read(path);
        const token = current ? fingerprint(current) : null;
        if (token !== baseline.token) {
          // An idle terminal's /exit, history or late title must not roll back
          // another writer. Keep the old baseline so later edits still conflict.
          if (current && nextProgress === baseline.progress) return;
          throw new SessionConflictError(snapshot.id);
        }
        const changed = !current || nextProgress !== progress(current);
        snapshot.updatedAt = changed
          ? new Date(Math.max(Date.now(), current ? (Date.parse(current.updatedAt) || 0) + 1 : 0)).toISOString()
          : current.updatedAt;
        const body = `${JSON.stringify(snapshot, null, 2)}\n`;
        const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`;
        try {
          await writeFile(temporary, body, { encoding: "utf8", mode: 0o600 });
          await rename(temporary, path);
        } finally { await rm(temporary, { force: true }).catch(() => undefined); }
        baseline.token = fingerprint(snapshot);
        baseline.progress = nextProgress;
        record.updatedAt = snapshot.updatedAt;
        // Mirror only the snapshot that actually committed, under the same lock.
        this.history?.append(snapshot);
      });
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
    return this.remember({
      ...structuredClone(source),
      id: newId(),
      // The branch marker only survives if the title stops being derived: a
      // derived title is recomputed from the opening line on the next save.
      // Trim the parent title rather than the suffix — "(branch)" is the part
      // that tells two forks of the same session apart.
      title: `${source.title.slice(0, MAX_TITLE_LENGTH - " (branch)".length)} (branch)`,
      titleSource: "model",
      messages,
      pendingInputs: [],
      createdAt: now,
      updatedAt: now,
    }, null);
  }

  /** Refresh an idle terminal without discarding its own queued saves. */
  async refresh(record: SessionRecord): Promise<SessionRecord | undefined> {
    const path = this.path(record);
    await SessionStore.writes.get(path);
    const current = await this.read(path);
    if (!current || fingerprint(current) === SessionStore.states.get(record)?.token) return undefined;
    return this.remember(current);
  }

  async load(reference: string, project?: string, workspace?: string): Promise<SessionRecord | undefined> {
    const entries = await this.list(project, workspace);
    const selected = reference === "latest"
      ? entries[0]
      : entries.find((entry) => entry.id === reference || entry.id.startsWith(reference));
    if (!selected) return undefined;
    try {
      const record = await this.read(this.path(selected));
      return record ? this.remember(record) : undefined;
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
          this.remember(data);
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
