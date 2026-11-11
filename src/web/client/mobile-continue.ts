import type { MeshJob, SessionSummary } from "./types";

/** A conversation the next instruction must be appended to. */
export interface Continuation {
  id: string;
  title: string;
  /** A job's session is stored under the job's project, not the phone's pick. */
  project?: string;
}

export interface ContinuationInput {
  /** The session the reader opened; it owns the transcript on screen. */
  picked?: Pick<SessionSummary, "id" | "title">;
  /** The job in the live view; its session is the conversation it belongs to. */
  job?: Pick<MeshJob, "session_id" | "title" | "project_id">;
  /** Newest first, as `/api/sessions` returns them; may not know the job's session yet. */
  sessions: SessionSummary[];
}

/**
 * Which conversation the next instruction appends to.
 *
 * Opening a session and sending one instruction used to clear the session
 * pointer, so the second instruction silently started a new conversation and
 * the phone showed two sessions where the reader meant one. The job that
 * carries the first turn already knows its session, so a follow-up sent while
 * that job is on screen has to stay in it.
 */
export function continuationForPrompt({ picked, job, sessions }: ContinuationInput): Continuation | undefined {
  if (picked) return { id: picked.id, title: picked.title };
  if (!job?.session_id) return undefined;
  const known = sessions.find(item => item.id === job.session_id);
  return {
    id: job.session_id,
    title: known?.title || job.title || "",
    ...(job.project_id ? { project: job.project_id } : {}),
  };
}
