import type { JobStatus } from "./types";

export interface EditView {
  tab: "code" | "changes";
  automatic?: { job: string; restore: "code" | "changes" };
  seen?: string;
}

/** Live edits borrow the code area; a manual tab choice cancels the loan. */
export function followEdit(view: EditView, job: string, status: JobStatus | undefined, edit?: string): EditView {
  const running = status === "queued" || status === "pending" || status === "working";
  let next = view;
  if (view.automatic && (view.automatic.job !== job || !running)) {
    next = { ...view, tab: view.automatic.restore, automatic: undefined };
  }
  const seen = edit ? `${job}:${edit}` : undefined;
  if (running && seen && seen !== next.seen) {
    return { tab: "changes", automatic: next.automatic ?? { job, restore: next.tab }, seen };
  }
  return next.seen === seen ? next : { ...next, seen };
}
