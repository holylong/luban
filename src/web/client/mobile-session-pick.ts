import type { SessionSummary } from "./types";

export interface SessionPickInput {
  /** Newest first, as `/api/sessions` returns them. */
  sessions: SessionSummary[];
  /** The reader picked a session, or 新会话, for this device themselves. */
  pinned: boolean;
  current?: SessionSummary;
  /** A job owns the live view; a session must not take it over. */
  jobSelected: boolean;
}

/**
 * The session a device opens on its own.
 *
 * Choosing a laptop used to land on an empty "让电脑帮你做什么？" even when that
 * laptop had been working all day; the newest session is what the reader means
 * by "open this device". Picking 新会话 sets `pinned`, so the choice sticks.
 */
export function pickDefaultSession({ sessions, pinned, current, jobSelected }: SessionPickInput): SessionSummary | undefined {
  if (pinned || current || jobSelected) return undefined;
  return sessions[0];
}
