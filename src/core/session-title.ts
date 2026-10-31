import type { ChatMessage } from "./types.js";

/**
 * Naming a session.
 *
 * The title used to be the first line of the first user message, verbatim. That
 * reads well for "fix the parser" and badly for everything else: a session
 * opened with "继续", "看看这个" or a pasted stack trace is labelled with a word
 * that says nothing about the work, and a pasted file names the session after
 * its first line of code. So the title is now written by the model, the way a
 * thread list names a thread, and the opening line survives only as the
 * fallback for when the model is unreachable.
 */

/** Longest title the UI and the session list are laid out for. */
export const MAX_TITLE_LENGTH = 72;

/**
 * Above this many words the model answered with a sentence instead of a name.
 * The first user line is a better title than a truncated paragraph, so this is
 * a rejection, not a clip. Chinese titles have no spaces and are bounded by
 * MAX_TITLE_LENGTH instead.
 */
const MAX_TITLE_WORDS = 14;

/** Values a model returns when it has nothing to name. */
const BOILERPLATE = new Set(["new session", "untitled", "untitled session", "session", "title", "n/a", "none", "无标题", "新会话", "会话", "标题"]);

/** Openers that say nothing about the work, so the next line names it instead. */
const TRIVIAL_OPENERS = new Set([
  "继续", "继续吧", "继续完成", "好", "好的", "行", "可以", "在吗", "?", "？", "…",
  "hi", "hello", "hey", "ok", "okay", "yes", "no", "continue", "go on", "go ahead",
]);

/** Longest placeholder title; the list is narrower than a model-written name. */
const FALLBACK_TITLE_LENGTH = 48;

function substance(text: string): string {
  return text
    .replace(/```[\s\S]*?(?:```|$)/g, " ")   // a pasted block says nothing about the intent
    .replace(/^[#>*\-\s]+/u, "")             // Markdown heading/quote/bullet decoration
    .replace(/\s+/g, " ")
    .trim();
}

function isTrivial(text: string): boolean {
  const flat = text.toLowerCase().replace(/[\s。.!！?？~～,，]+$/u, "");
  return !flat || TRIVIAL_OPENERS.has(flat) || flat.length < 2;
}

/**
 * Placeholder title for a session the model has not named yet.
 *
 * It used to be the first line verbatim, which labelled a session "继续" or with
 * the first line of a pasted stack trace. The opening line is kept when it says
 * something, otherwise the first substantive user message wins and code blocks
 * and Markdown decoration are stripped, so the placeholder already reads like a
 * topic until the model replaces it.
 */
export function fallbackTitle(messages: ChatMessage[]): string {
  const openings = messages
    .filter((message) => message.role === "user" && typeof message.content === "string" && !message.name && message.content.trim())
    .map((message) => String(message.content).split("\n").map(line => line.trim()).find(Boolean) ?? "");
  const chosen = openings.find((line) => !isTrivial(substance(line))) ?? openings[0] ?? "";
  const line = substance(chosen);
  if (!line) return "New session";
  return line.length > FALLBACK_TITLE_LENGTH ? `${line.slice(0, FALLBACK_TITLE_LENGTH).trimEnd()}…` : line.slice(0, MAX_TITLE_LENGTH);
}

/**
 * Turn a model reply into a title, or `undefined` when the reply is not one.
 *
 * Models wrap names in quotes, prefix them with "Title:", answer with a bullet
 * or a short paragraph, and occasionally return reasoning instead of an answer.
 * All of that has to be rejected here rather than stored, because the stored
 * title is what the session list shows and there is no second chance to fix it.
 */
export function cleanTitle(raw: unknown): string | undefined {
  if (typeof raw !== "string") return undefined;
  let text = raw.trim();
  if (!text) return undefined;

  // "Title: Fix the parser" — take the value, not the label.
  const labelled = /^(?:title|session title|标题|会话标题)\s*[:：]\s*(.+)$/im.exec(text);
  if (labelled?.[1]?.trim()) text = labelled[1].trim();

  // Markdown decoration and wrapping quotes are not part of the name.
  text = text.replace(/[*_`#]/g, "");
  text = text.replace(/^["'“”‘’「」『』]+/, "").replace(/["'“”‘’「」『』]+$/, "").trim();

  // A model that answers with several lines meant to explain, not to name.
  text = text.split("\n")[0]!.trim();
  text = text.replace(/\s+/g, " ");
  text = text.replace(/[\s.。!！?？,，;；:：、-]+$/u, "").trim();

  if (!text) return undefined;
  if (text.length > MAX_TITLE_LENGTH) return undefined;
  if (BOILERPLATE.has(text.toLowerCase())) return undefined;
  if (text.split(" ").length > MAX_TITLE_WORDS) return undefined;
  return text;
}

const TITLE_INSTRUCTION = [
  "You name coding sessions for a session list.",
  "Read the opening exchange and reply with a title for the work: one line, at most 8 words,",
  "concrete about what is being changed rather than a generic verb, in the language the user writes in.",
  "No surrounding quotes, no trailing period, no \"Title:\" prefix.",
  "Reply with the title only. Do not answer the user, do not explain, do not continue the task.",
].join(" ");

/** Characters of conversation the title call sees; enough to name the work. */
const TRANSCRIPT_BUDGET = 1_800;
/** Messages from the opening of the session; later turns drift off topic. */
const TRANSCRIPT_MESSAGES = 6;
/** Per-message clip, so one pasted file cannot fill the whole budget. */
const TRANSCRIPT_MESSAGE_LIMIT = 500;

function oneLine(value: unknown, limit: number): string {
  const text = typeof value === "string" ? value : "";
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > limit ? `${flat.slice(0, limit)}…` : flat;
}

/**
 * The conversation the title is written from, as a transcript the model can
 * read in one glance. Tool calls are included by name only: "read every note
 * file" and "fix the parser" often differ solely in which tools ran, while the
 * tool output itself is what would blow the budget.
 */
export function titleTranscript(messages: ChatMessage[]): string {
  const lines: string[] = [];
  let used = 0;
  for (const message of messages) {
    if (lines.length >= TRANSCRIPT_MESSAGES || used >= TRANSCRIPT_BUDGET) break;
    if (message.role === "system") continue;
    let line: string;
    if (message.role === "user") line = `User: ${oneLine(message.content, TRANSCRIPT_MESSAGE_LIMIT)}`;
    else if (message.role === "assistant") {
      const tools = (message.tool_calls ?? []).map((call) => call.function.name);
      const said = oneLine(message.content, TRANSCRIPT_MESSAGE_LIMIT);
      line = tools.length
        ? `Assistant: ${said}${said ? " " : ""}(called ${tools.join(", ")})`
        : `Assistant: ${said}`;
    } else line = `Tool: ${oneLine(message.content, 200)}`;
    if (!line.replace(/^\w+: ?/, "").trim()) continue;
    lines.push(line);
    used += line.length;
  }
  return lines.join("\n").slice(0, TRANSCRIPT_BUDGET);
}

/**
 * Request the model names the session. Returned as `ChatMessage[]` so the
 * caller only has to hand it to the client, and so the wording is testable.
 */
export function titlePrompt(messages: ChatMessage[]): ChatMessage[] {
  return [
    { role: "system", content: TITLE_INSTRUCTION },
    { role: "user", content: `Name this session.\n\n${titleTranscript(messages)}` },
  ];
}

/**
 * Whether a session is worth naming: there has to be something the model can
 * read. A bare "hi" gets the fallback rather than a paid round trip.
 */
export function hasNameableContent(messages: ChatMessage[]): boolean {
  const users = messages.filter((message) => message.role === "user" && typeof message.content === "string" && message.content.trim());
  if (!users.length) return false;
  return titleTranscript(messages).length >= 16;
}
