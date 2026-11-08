import { resolve } from "node:path";
import type { SessionRecord } from "./types.js";
import type { JobStreamEvent, JobStreamRecord } from "./mesh/runtime.js";

export interface LiveSessionSnapshot {
  session: SessionRecord;
  running: boolean;
  events: JobStreamRecord[];
  baseMessageCount: number;
}

interface Entry {
  snapshot: LiveSessionSnapshot;
  bytes: number;
  sizes: number[];
  sequence: number;
}

const MAX_EVENTS = 1200;
const MAX_EVENT_BYTES = 2 * 1024 * 1024;
const MAX_COALESCED_BYTES = 64 * 1024;
const MAX_INACTIVE_SESSIONS = 64;

/** Process-local bridge. Every input/output is cloned; homes are isolated. */
export class LiveSessionRegistry {
  private readonly snapshots = new Map<string, Entry>();
  private key(home: string, project: string, id: string): string {
    return JSON.stringify([resolve(home), project, id]);
  }

  private replace(home: string, session: SessionRecord, running: boolean): void {
    const key = this.key(home, session.project, session.id);
    this.snapshots.delete(key);
    this.snapshots.set(key, {
      snapshot: { session: structuredClone(session), running, events: [], baseMessageCount: session.messages.length },
      bytes: 0, sizes: [], sequence: 0,
    });
    this.prune();
  }

  /** Bound retained inactive transcripts; never evict an active run. */
  private prune(): void {
    let inactive = [...this.snapshots.values()].filter(entry => !entry.snapshot.running).length;
    for (const [key, entry] of this.snapshots) {
      if (inactive <= MAX_INACTIVE_SESSIONS) break;
      if (!entry.snapshot.running) { this.snapshots.delete(key); inactive--; }
    }
  }

  /** Refresh metadata, preserving the replay baseline while running. */
  publish(home: string, session: SessionRecord): void {
    const previous = this.snapshots.get(this.key(home, session.project, session.id));
    if (!previous?.snapshot.running) { this.replace(home, session, false); return; }
    // Do not clone the full transcript just to throw it away during a run.
    const messages = previous.snapshot.session.messages;
    previous.snapshot.session = structuredClone({ ...session, messages: [] });
    previous.snapshot.session.messages = messages;
  }

  start(home: string, session: SessionRecord): void {
    this.replace(home, session, true);
  }

  /**
   * Only call at a boundary where all previous events are durable messages
   * (before a model call or after accepting input). Clear replay atomically so
   * those messages cannot render twice. Generic publish is NOT such a boundary.
   */
  checkpoint(home: string, session: SessionRecord): void {
    const entry = this.snapshots.get(this.key(home, session.project, session.id));
    if (!entry?.snapshot.running) return;
    entry.snapshot.session = structuredClone(session);
    entry.snapshot.baseMessageCount = session.messages.length;
    entry.snapshot.events = [];
    entry.bytes = 0;
    entry.sizes = [];
  }

  /** Bounded replay; timestamps use epoch seconds, sequences count accepted events. */
  append(home: string, project: string, id: string, event: JobStreamEvent): void {
    const entry = this.snapshots.get(this.key(home, project, id));
    if (!entry?.snapshot.running) return;
    const serialized = JSON.stringify(event);
    if (Buffer.byteLength(serialized) > MAX_EVENT_BYTES / 2) return;
    const item = { seq: ++entry.sequence, at: Date.now() / 1000, event: structuredClone(event) };
    const size = Buffer.byteLength(JSON.stringify(item));
    const events = entry.snapshot.events;
    const last = events.at(-1);
    // Cap each chunk: concatenation/serialization never scales with the entire
    // reply, and thousands of token deltas do not consume thousands of slots.
    if ((event.kind === "delta" || event.kind === "thinking") && last?.event.kind === event.kind
      && entry.sizes.at(-1)! + size <= MAX_COALESCED_BYTES) {
      const oldSize = entry.sizes.pop()!;
      last.event.text += event.text;
      last.seq = item.seq;
      last.at = item.at;
      const newSize = Buffer.byteLength(JSON.stringify(last));
      entry.sizes.push(newSize);
      entry.bytes += newSize - oldSize;
    } else {
      events.push(item);
      entry.sizes.push(size);
      entry.bytes += size;
    }
    while (events.length > MAX_EVENTS || entry.bytes + events.length + 1 > MAX_EVENT_BYTES) {
      events.shift();
      entry.bytes -= entry.sizes.shift()!;
    }
  }

  finish(home: string, session: SessionRecord): void {
    this.replace(home, session, false);
  }

  get(home: string, project: string, id: string): LiveSessionSnapshot | undefined {
    const entry = this.snapshots.get(this.key(home, project, id));
    return entry ? structuredClone(entry.snapshot) : undefined;
  }

  list(home: string, project: string): LiveSessionSnapshot[] {
    const prefix = JSON.stringify([resolve(home), project]).slice(0, -1) + ",";
    return [...this.snapshots].filter(([key]) => key.startsWith(prefix)).map(([, entry]) => structuredClone(entry.snapshot));
  }

  remove(home: string, project: string, id: string): void {
    this.snapshots.delete(this.key(home, project, id));
  }
}

export const liveSessions = new LiveSessionRegistry();
