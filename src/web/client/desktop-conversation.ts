import type { MeshJob, SessionDetail, SessionSummary } from "./types";

/** Keep the current round in the live timeline, not twice in the saved history. */
export function historyBeforeRun(session: SessionDetail, job?: MeshJob): SessionDetail {
  if (!job || job.session_id !== session.id || Date.parse(session.updatedAt) / 1000 < job.created_at) return session;
  let start = -1;
  session.messages.forEach((message, index) => {
    if (message.role === "user" && message.content === job.instruction) start = index;
  });
  return start < 0 ? session : { ...session, messages: session.messages.slice(0, start) };
}

/** One navigation entry per conversation, even when many execution rounds exist. */
export function conversationEntries(sessions: SessionSummary[], jobs: MeshJob[], project: string) {
  const entries = sessions.map(session => ({ id: session.id, title: session.title, sessionId: session.id, job: undefined as MeshJob | undefined }));
  for (const job of [...jobs].sort((a, b) => b.created_at - a.created_at)) {
    if (job.project_id !== project) continue;
    const id = job.session_id || job.id;
    const existing = entries.find(entry => entry.id === id);
    if (existing) { if (!existing.job) existing.job = job; }
    else entries.push({ id, title: job.title || job.instruction, sessionId: job.session_id || "", job });
  }
  return entries;
}
