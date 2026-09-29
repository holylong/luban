import { createRequire } from "node:module";
import { existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import type { DatabaseSync, StatementSync } from "node:sqlite";
import type { ChatMessage, HistorySettings, SessionRecord } from "./types.js";

/** One stored message, as returned by `SessionHistory.search`. */
export interface HistoryHit {
  sessionId: string;
  /** Position of the message in the mirrored session. */
  seq: number;
  role: string;
  createdAt: string;
  message: ChatMessage;
}

/** One mirrored session, as returned by `SessionHistory.sessions`. */
export interface HistorySession {
  id: string;
  project: string;
  workspace: string;
  title: string;
  updatedAt: string;
  /** Rows currently stored for this session, after any window trimming. */
  messages: number;
}

/**
 * Tables the mirror needs. `search_text` holds what the message says rather
 * than its JSON encoding, so a query for `role` matches a transcript that
 * talks about roles instead of every stored row's field name.
 */
const SCHEMA = `
  CREATE TABLE IF NOT EXISTS sessions (
    id TEXT PRIMARY KEY,
    project TEXT NOT NULL,
    workspace TEXT NOT NULL,
    title TEXT NOT NULL,
    model TEXT NOT NULL,
    mode TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    first_seq INTEGER NOT NULL,
    next_seq INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS session_messages (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    session_id TEXT NOT NULL,
    seq INTEGER NOT NULL,
    role TEXT NOT NULL,
    name TEXT,
    tool_call_id TEXT,
    fingerprint TEXT NOT NULL,
    created_at TEXT NOT NULL,
    search_text TEXT NOT NULL,
    message TEXT NOT NULL
  );
  CREATE UNIQUE INDEX IF NOT EXISTS session_messages_position ON session_messages(session_id, seq);
  CREATE INDEX IF NOT EXISTS session_messages_role ON session_messages(role);
`;

/**
 * Append-only SQLite mirror of session messages.
 *
 * The JSON records under `sessions-node/` stay authoritative: resume, branch,
 * export and the Web API all read them. This database is a side channel that
 * makes the same history queryable while a session grows, and it is written
 * one message at a time — rewriting the whole JSON snapshot after every step
 * is what made long sessions quadratic in writes.
 *
 * The mirror follows the record it is given. A record whose list shrank or was
 * cut (context compaction, `/branch`, a repair that replaced a tool result)
 * drops that session's rows and is mirrored again from the start, so the rows
 * never claim to be a transcript the JSON no longer holds.
 */
export class SessionHistory {
  private readonly insertMessage: StatementSync;
  private readonly upsertSession: StatementSync;
  private readonly rowAt: StatementSync;
  private readonly sessionWindow: StatementSync;
  private readonly dropBefore: StatementSync;
  private readonly dropSession: StatementSync;
  private readonly selectMessages: StatementSync;
  private readonly selectCount: StatementSync;
  private readonly searchRows: StatementSync;
  private readonly listSessions: StatementSync;
  /** Messages already mirrored per session, as `[first, next)` positions. */
  private readonly windows = new Map<string, { first: number; next: number }>();
  private closed = false;

  private constructor(private readonly db: DatabaseSync, private readonly maxMessagesPerSession: number) {
    this.insertMessage = db.prepare(`
      INSERT OR REPLACE INTO session_messages (session_id, seq, role, name, tool_call_id, fingerprint, created_at, search_text, message)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    this.upsertSession = db.prepare(`
      INSERT INTO sessions (id, project, workspace, title, model, mode, updated_at, first_seq, next_seq)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        project = excluded.project, workspace = excluded.workspace, title = excluded.title,
        model = excluded.model, mode = excluded.mode, updated_at = excluded.updated_at,
        first_seq = excluded.first_seq, next_seq = excluded.next_seq
    `);
    this.rowAt = db.prepare("SELECT fingerprint FROM session_messages WHERE session_id = ? AND seq = ?");
    this.sessionWindow = db.prepare("SELECT first_seq, next_seq FROM sessions WHERE id = ?");
    this.dropBefore = db.prepare("DELETE FROM session_messages WHERE session_id = ? AND seq < ?");
    this.dropSession = db.prepare("DELETE FROM session_messages WHERE session_id = ?");
    this.selectMessages = db.prepare("SELECT message FROM session_messages WHERE session_id = ? ORDER BY seq");
    this.selectCount = db.prepare("SELECT COUNT(*) AS total FROM session_messages WHERE session_id = ?");
    this.searchRows = db.prepare(`
      SELECT session_id, seq, role, created_at, message FROM session_messages
      WHERE search_text LIKE ? ESCAPE '\\' ORDER BY id DESC LIMIT ?
    `);
    this.listSessions = db.prepare(`
      SELECT s.id, s.project, s.workspace, s.title, s.updated_at,
             (SELECT COUNT(*) FROM session_messages m WHERE m.session_id = s.id) AS messages
      FROM sessions s
      WHERE (? IS NULL OR s.project = ?)
      ORDER BY s.updated_at DESC LIMIT ?
    `);
  }

  /**
   * Open the mirror, or return `undefined` when it is disabled or the runtime
   * cannot provide it. A missing `node:sqlite` (Node 20 and 21 predate it) is
   * reported once on stderr instead of failing the run.
   */
  static open(settings: HistorySettings, home: string): SessionHistory | undefined {
    if (!settings.enabled) return undefined;
    const sqlite = loadSqlite();
    if (!sqlite) {
      process.stderr.write("history is enabled but this Node runtime has no node:sqlite (Node 22.5+); continuing without the queryable mirror\n");
      return undefined;
    }
    const directory = settings.directory || join(home, "history");
    try {
      mkdirSync(directory, { recursive: true });
      const db = new sqlite.DatabaseSync(join(directory, "history.sqlite"));
      // A TUI and a serve daemon routinely share one home; WAL plus a busy
      // timeout lets both mirror without one blocking the other's turn.
      db.exec("PRAGMA journal_mode = WAL");
      db.exec("PRAGMA busy_timeout = 2000");
      db.exec(SCHEMA);
      return new SessionHistory(db, settings.maxMessagesPerSession);
    } catch (error) {
      // The mirror is derived data: a database that cannot be created must not
      // stop the agent, but the reason has to be visible rather than implied.
      process.stderr.write(`history database unavailable (${error instanceof Error ? error.message : String(error)}); continuing without the queryable mirror\n`);
      return undefined;
    }
  }

  /**
   * Open an existing mirror for reading without enabling the writer, so
   * `luban history` and the Web query API work even while `history.enabled`
   * is false or on a runtime that cannot mirror.
   *
   * @param settings `history` block from the loaded config.
   * @param home luban home directory the mirror defaults under.
   * @returns The reader, or `undefined` when no database has been written yet.
   */
  static openForRead(settings: HistorySettings, home: string): SessionHistory | undefined {
    const file = join(settings.directory || join(home, "history"), "history.sqlite");
    if (!existsSync(file)) return undefined;
    const sqlite = loadSqlite();
    if (!sqlite) return undefined;
    try {
      const db = new sqlite.DatabaseSync(file, { readOnly: true });
      db.exec("PRAGMA busy_timeout = 2000");
      return new SessionHistory(db, settings.maxMessagesPerSession);
    } catch (error) {
      process.stderr.write(`history database could not be read (${error instanceof Error ? error.message : String(error)})\n`);
      return undefined;
    }
  }

  /**
   * Mirror the messages appended since the previous call for this session.
   *
   * @param session Durable record the messages belong to.
   * @param messages Message list to mirror; defaults to the record's own list.
   * @returns Rows written, which is zero when the mirror is already current.
   */
  append(session: SessionRecord, messages: ChatMessage[] = session.messages): number {
    if (this.closed) return 0;
    const window = this.cursorFor(session, messages);
    const from = window.next;
    try {
      const now = new Date().toISOString();
      for (let seq = from; seq < messages.length; seq += 1) {
        const message = messages[seq]!;
        this.insertMessage.run(session.id, seq, message.role, message.name ?? null, message.tool_call_id ?? null,
          fingerprint(message), now, searchText(message), JSON.stringify(message));
      }
      window.next = messages.length;
      this.trim(session.id, window);
      this.upsertSession.run(session.id, session.project, session.workspace, session.title, session.model, session.mode,
        session.updatedAt, window.first, window.next);
      return messages.length - from;
    } catch (error) {
      // A failing mirror self-disables: the session JSON keeps being written,
      // and one clear line says why the queryable copy stopped.
      this.closed = true;
      process.stderr.write(`history mirror stopped (${error instanceof Error ? error.message : String(error)}); session JSON is unaffected\n`);
      return 0;
    }
  }

  /** Stored messages for one session, in order. */
  messages(sessionId: string): ChatMessage[] {
    if (this.closed) return [];
    return this.selectMessages.all(sessionId).map((row) => JSON.parse(String(row.message)) as ChatMessage);
  }

  /** Rows mirrored for one session. */
  count(sessionId: string): number {
    if (this.closed) return 0;
    const row = this.selectCount.get(sessionId);
    return row ? Number(row.total) : 0;
  }

  /** Most recent messages containing `query`, newest first. */
  search(query: string, limit = 20): HistoryHit[] {
    if (this.closed) return [];
    const escaped = query.replaceAll(/[\\%_]/gu, (character) => `\\${character}`);
    return this.searchRows.all(`%${escaped}%`, limit).map((row) => ({
      sessionId: String(row.session_id),
      seq: Number(row.seq),
      role: String(row.role),
      createdAt: String(row.created_at),
      message: JSON.parse(String(row.message)) as ChatMessage,
    }));
  }

  /**
   * Mirrored sessions, most recently updated first.
   *
   * @param project Only sessions of this project; all projects when omitted.
   * @param limit Maximum rows returned.
   * @returns Session metadata plus the number of stored messages.
   */
  sessions(project?: string, limit = 50): HistorySession[] {
    if (this.closed) return [];
    // Bind both project slots explicitly: node:sqlite reports a trailing
    // unbound parameter as `datatype mismatch`.
    const scope = project ?? null;
    return this.listSessions.all(scope, scope, limit).map((row) => ({
      id: String(row.id),
      project: String(row.project),
      workspace: String(row.workspace),
      title: String(row.title),
      updatedAt: String(row.updated_at),
      messages: Number(row.messages),
    }));
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.db.close();
  }

  /**
   * Where the mirror stopped for this session. A session first seen in this
   * process resumes from the stored window; a list that shrank, or one whose
   * boundaries no longer match the stored rows, is mirrored again from zero.
   */
  private cursorFor(session: SessionRecord, messages: ChatMessage[]): { first: number; next: number } {
    const window = this.windows.get(session.id) ?? this.storedWindow(session.id);
    const stale = window.next > messages.length
      || (window.next > 0 && !this.matches(session.id, window.next - 1, messages[window.next - 1]))
      || (window.first > 0 && !this.matches(session.id, window.first, messages[window.first]));
    if (window.next > 0 && stale) {
      this.dropSession.run(session.id);
      const reset = { first: 0, next: 0 };
      this.windows.set(session.id, reset);
      return reset;
    }
    this.windows.set(session.id, window);
    return window;
  }

  private storedWindow(sessionId: string): { first: number; next: number } {
    const row = this.sessionWindow.get(sessionId);
    return row ? { first: Number(row.first_seq), next: Number(row.next_seq) } : { first: 0, next: 0 };
  }

  private matches(sessionId: string, seq: number, message: ChatMessage | undefined): boolean {
    if (!message) return false;
    const row = this.rowAt.get(sessionId, seq);
    return Boolean(row) && String(row!.fingerprint) === fingerprint(message);
  }

  /** Drop the oldest rows so one session cannot grow past the configured window. */
  private trim(sessionId: string, window: { first: number; next: number }): void {
    if (this.maxMessagesPerSession <= 0) return;
    const excess = window.next - window.first - this.maxMessagesPerSession;
    if (excess <= 0) return;
    this.dropBefore.run(sessionId, window.first + excess);
    window.first += excess;
  }
}

/** Retained across stores: a daemon builds a `SessionStore` per request. */
const shared = new Map<string, SessionHistory>();

/** Directories already reported as unopenable, so a daemon warns once. */
const reported = new Set<string>();

/**
 * The mirror for one data directory, opened at most once per process.
 *
 * @param settings `history` block from the loaded config; a config built
 *   without one (tests, embeddings) is treated as disabled rather than fatal.
 * @param home luban home directory the mirror defaults under.
 * @returns The shared mirror, or `undefined` when it is disabled or unavailable.
 */
export function sharedHistory(settings: HistorySettings | undefined, home: string): SessionHistory | undefined {
  if (!settings?.enabled) return undefined;
  const directory = settings.directory || join(home, "history");
  const existing = shared.get(directory);
  if (existing) return existing;
  if (reported.has(directory)) return undefined;
  const opened = SessionHistory.open(settings, home);
  if (opened) shared.set(directory, opened);
  else reported.add(directory);
  return opened;
}

/**
 * Text a search matches against: what the message says, not its JSON encoding.
 * Searching the stored `message` column would match on escaping and on field
 * names such as `tool_calls`, so a query for `role` would hit every row.
 */
function searchText(message: ChatMessage): string {
  const calls = message.tool_calls?.map((call) => `${call.function.name} ${call.function.arguments}`).join("\n") ?? "";
  return [message.content ?? "", calls].filter(Boolean).join("\n");
}

/**
 * Message summary used to detect that the mirrored list changed basis: role,
 * identifiers, length, both ends of the content, and the tool calls. Cheap
 * enough to run per save, exact enough that compaction, branching or a
 * repaired tool result never passes as an append.
 */
function fingerprint(message: ChatMessage): string {
  const content = message.content ?? "";
  const calls = message.tool_calls?.map((call) => `${call.id}:${call.function.name}:${call.function.arguments.length}`).join(",") ?? "";
  return [message.role, message.name ?? "", message.tool_call_id ?? "", content.length, content.slice(0, 48), content.slice(-48), calls].join("|");
}

/**
 * `node:sqlite` is experimental, so loading it logs an ExperimentalWarning on
 * every start. The mirror is opened deliberately, so that one message is
 * filtered while anything else the runtime raises during the load passes on.
 */
function loadSqlite(): typeof import("node:sqlite") | undefined {
  const require = createRequire(import.meta.url);
  const original = process.emitWarning.bind(process);
  process.emitWarning = ((warning: string | Error, ...rest: unknown[]) => {
    const text = typeof warning === "string" ? warning : warning.message;
    if (rest[0] === "ExperimentalWarning" && text.includes("SQLite")) return;
    (original as unknown as (warning: string | Error, ...rest: unknown[]) => void)(warning, ...rest);
  }) as typeof process.emitWarning;
  try {
    return require("node:sqlite") as typeof import("node:sqlite");
  } catch {
    // Node 20 and 21 predate node:sqlite, which `engines` still allows.
    return undefined;
  } finally {
    process.emitWarning = original;
  }
}
