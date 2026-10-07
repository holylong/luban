export interface UserQuestion {
  question: string;
  options: Array<{ label: string; description?: string }>;
}

export type AskUser = (question: UserQuestion, signal: AbortSignal) => Promise<string>;

/** Reject malformed model output before opening a human prompt. */
export function parseUserQuestion(args: Record<string, unknown>): UserQuestion {
  const question = typeof args.question === "string" ? args.question.trim() : "";
  if (!question || question.length > 1000) throw new Error("question must be 1–1000 characters");
  if (!Array.isArray(args.options) || args.options.length < 2 || args.options.length > 4) {
    throw new Error("options must contain 2–4 choices");
  }
  const options = args.options.map((item) => {
    if (!item || typeof item !== "object" || Array.isArray(item)) throw new Error("each option must be an object");
    const value = item as Record<string, unknown>;
    const label = typeof value.label === "string" ? value.label.trim() : "";
    if (!label || label.length > 100) throw new Error("option labels must be 1–100 characters");
    const description = typeof value.description === "string" ? value.description.trim().slice(0, 300) : undefined;
    return { label, ...(description ? { description } : {}) };
  });
  if (new Set(options.map(option => option.label)).size !== options.length) throw new Error("option labels must be unique");
  return { question, options };
}
