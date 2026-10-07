/**
 * Kev client: luban's "杜断" half of 房谋杜断.
 *
 * The chat model proposes options; a local Kev server (github.com/jaredpalmer/kev)
 * scores them. Kev is not a chat model - it exposes exactly one useful endpoint,
 * `POST /v1/systemone`, which takes a state plus typed questions and returns
 * calibrated probabilities. So it is wired in as a *tool* the agent can call,
 * never as a model backend (luban's OpenAiClient would post to
 * `/chat/completions`, which Kev does not implement).
 *
 * Shapes here mirror kev/api.py: Noul -> p(true), Choice -> argmax over named
 * criteria, Score -> expected level over ordered criteria.
 */
import type { KevSettings, ToolDefinition } from "./types.js";

/** kev/api.py MAX_OPTIONS: a Choice question accepts 1..255 criteria. */
export const KEV_MAX_OPTIONS = 255;

export type KevQuestionType = "noul" | "choice" | "score";

export interface KevQuestion {
  type: KevQuestionType;
  /** Free-text framing the model reads before the options. */
  instructions?: string;
  /** choice: option name -> optional description. score: ordered level descriptions. */
  options?: Record<string, string | null> | string[];
}

export interface KevAnswer {
  type: KevQuestionType;
  /** noul: probability of "yes" (0..1). */
  probability?: number;
  /** choice: the most likely option name. */
  choice?: string;
  /** choice/score: how far the distribution is from uniform (0..1). */
  confidence?: number;
  /** score: expected level. */
  score?: number;
  /** Every option's probability, keyed by option name (choice) or level index (score). */
  probabilities?: Record<string, number>;
  /** score: level index -> description. */
  legend?: Record<string, string>;
}

export interface KevResponse {
  model: string;
  answers: Record<string, KevAnswer>;
  usage?: { input_tokens?: number; output_tokens?: number; state_tokens?: number; state_tokens_used?: number };
  latency_ms?: number;
  /** Present only when the server was started with KEV_TRUNCATE_STATES=1 and the state was cut. */
  truncated?: boolean;
}

function endpoint(baseUrl: string): string {
  const value = baseUrl.replace(/\/+$/, "");
  if (value.endsWith("/v1/systemone")) return value;
  return `${value}/v1/systemone`;
}

/** kev/api.py to_record(): option name alone when the description is empty, else "name: desc". */
function criteriaFor(question: KevQuestion): Record<string, string | null> | string[] {
  const options = question.options;
  if (question.type === "score") {
    if (!Array.isArray(options) || !options.length) throw new Error("score questions need an ordered `options` array of level descriptions");
    if (options.length > KEV_MAX_OPTIONS) throw new Error(`score accepts at most ${KEV_MAX_OPTIONS} levels`);
    return options.map(String);
  }
  if (question.type === "noul") return {};
  if (Array.isArray(options)) {
    if (!options.length) throw new Error("choice questions need at least one option");
    if (options.length > KEV_MAX_OPTIONS) throw new Error(`choice accepts at most ${KEV_MAX_OPTIONS} options`);
    return Object.fromEntries(options.map((name) => [String(name), null]));
  }
  const entries = Object.entries(options ?? {});
  if (!entries.length) throw new Error("choice questions need at least one option");
  if (entries.length > KEV_MAX_OPTIONS) throw new Error(`choice accepts at most ${KEV_MAX_OPTIONS} options`);
  return Object.fromEntries(entries.map(([name, description]) => [name, description == null ? null : String(description)]));
}

/** Build the POST /v1/systemone body from luban-side question descriptions. */
export function buildKevRequest(state: string, questions: Record<string, KevQuestion>, model: string): Record<string, unknown> {
  if (!state.trim()) throw new Error("kev_decide needs a non-empty state: the text the decision is made against");
  const ids = Object.keys(questions);
  if (!ids.length) throw new Error("kev_decide needs at least one question");
  const body: Record<string, unknown> = {};
  for (const id of ids) {
    const question = questions[id];
    const entry: Record<string, unknown> = { type: question.type, criteria: criteriaFor(question) };
    if (question.instructions?.trim()) entry.instructions = question.instructions.trim();
    body[id] = entry;
  }
  return { state, model: model || "kev-latest", questions: body };
}

function number(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function probabilityMap(value: unknown): Record<string, number> | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const entries = Object.entries(value as Record<string, unknown>)
    .flatMap(([key, val]) => (number(val) === undefined ? [] : [[key, number(val) as number] as const]));
  return entries.length ? Object.fromEntries(entries) : undefined;
}

/** Normalize one answer, accepting any extra fields the server adds. */
function normalizeAnswer(value: unknown): KevAnswer {
  const raw = (value && typeof value === "object" ? value : {}) as Record<string, unknown>;
  const type = raw.type === "choice" || raw.type === "score" ? raw.type : "noul";
  const answer: KevAnswer = { type };
  if (type === "noul") answer.probability = number(raw.noul);
  if (type === "choice") answer.choice = typeof raw.choice === "string" ? raw.choice : undefined;
  if (type === "score") answer.score = number(raw.score);
  answer.confidence = number(raw.confidence);
  answer.probabilities = probabilityMap(raw.probabilities);
  if (raw.legend && typeof raw.legend === "object" && !Array.isArray(raw.legend)) {
    answer.legend = Object.fromEntries(Object.entries(raw.legend as Record<string, unknown>).map(([key, val]) => [key, String(val)]));
  }
  return answer;
}

export class KevClient {
  constructor(private readonly settings: KevSettings) {}

  get enabled(): boolean {
    return Boolean(this.settings.url.trim());
  }

  /**
   * Ask one or more typed questions about `state`. Each question is independent:
   * they share the state text but cannot read each other's answers, so pack only
   * questions that stand alone.
   */
  async decide(state: string, questions: Record<string, KevQuestion>, signal?: AbortSignal): Promise<KevResponse> {
    if (!this.enabled) throw new Error("Kev is not configured; set `kev.url` in config.json (or LUBAN_KEV_URL) to a running kev.serve");
    const body = buildKevRequest(state, questions, this.settings.model);
    const controller = new AbortController();
    const seconds = Math.max(1, this.settings.timeoutSeconds || 120);
    const abort = () => controller.abort(signal?.reason ?? new Error("aborted"));
    const timer = setTimeout(() => controller.abort(new Error(`kev request timed out after ${seconds}s`)), seconds * 1_000);
    signal?.addEventListener("abort", abort, { once: true });
    try {
      const headers: Record<string, string> = { "content-type": "application/json", accept: "application/json" };
      if (this.settings.apiKey.trim()) headers.authorization = `Bearer ${this.settings.apiKey.trim()}`;
      const response = await fetch(endpoint(this.settings.url), {
        method: "POST",
        headers,
        body: JSON.stringify(body),
        signal: controller.signal,
      });
      const text = await response.text();
      if (!response.ok) throw new Error(`kev HTTP ${response.status}: ${text.slice(0, 500)}`);
      let parsed: unknown;
      try { parsed = JSON.parse(text); } catch { throw new Error(`kev returned non-JSON: ${text.slice(0, 200)}`); }
      const raw = (parsed && typeof parsed === "object" ? parsed : {}) as Record<string, unknown>;
      const answers = Object.fromEntries(Object.entries((raw.answers && typeof raw.answers === "object" ? raw.answers : {}) as Record<string, unknown>)
        .map(([id, value]) => [id, normalizeAnswer(value)]));
      return {
        model: typeof raw.model === "string" ? raw.model : this.settings.model,
        answers,
        usage: raw.usage && typeof raw.usage === "object" ? raw.usage as KevResponse["usage"] : undefined,
        latency_ms: number(raw.latency_ms),
        truncated: raw.truncated === true ? true : undefined,
      };
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener("abort", abort);
    }
  }

  /** `/v1/models`: one card per accepted model name, plus the serving details. */
  async models(signal?: AbortSignal): Promise<unknown> {
    if (!this.enabled) throw new Error("Kev is not configured; set `kev.url` in config.json (or LUBAN_KEV_URL)");
    const base = this.settings.url.replace(/\/+$/, "").replace(/\/v1\/systemone$/, "");
    const headers: Record<string, string> = { accept: "application/json" };
    if (this.settings.apiKey.trim()) headers.authorization = `Bearer ${this.settings.apiKey.trim()}`;
    const response = await fetch(`${base}/v1/models`, { headers, signal });
    const text = await response.text();
    if (!response.ok) throw new Error(`kev HTTP ${response.status}: ${text.slice(0, 500)}`);
    return JSON.parse(text);
  }
}

/**
 * One question as the agent supplies it in tool arguments. `options` is an
 * object for choice (name -> description) and an array for score (ordered).
 */
interface RawQuestion {
  type?: unknown;
  instructions?: unknown;
  options?: unknown;
}

export function parseKevQuestions(value: unknown): Record<string, KevQuestion> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("questions must be an object keyed by question id");
  const result: Record<string, KevQuestion> = {};
  for (const [id, raw] of Object.entries(value as Record<string, RawQuestion>)) {
    const type = raw?.type;
    if (type !== "noul" && type !== "choice" && type !== "score") throw new Error(`question ${id}: type must be noul, choice or score`);
    const question: KevQuestion = { type };
    if (typeof raw.instructions === "string") question.instructions = raw.instructions;
    if (Array.isArray(raw.options)) question.options = raw.options.map((option) => String(option));
    else if (raw.options && typeof raw.options === "object") {
      question.options = Object.fromEntries(Object.entries(raw.options as Record<string, unknown>)
        .map(([name, description]) => [name, description == null ? null : String(description)]));
    }
    result[id] = question;
  }
  return result;
}

/** Render one answer as a compact human-readable line for the model to read. */
export function describeAnswer(id: string, answer: KevAnswer): string {
  const pct = (value: number | undefined) => value === undefined ? "?" : `${(value * 100).toFixed(1)}%`;
  const distribution = answer.probabilities
    ? Object.entries(answer.probabilities).sort((a, b) => b[1] - a[1]).map(([key, value]) => `${key} ${pct(value)}`).join(", ")
    : "";
  if (answer.type === "noul") return `${id}: yes ${pct(answer.probability)}${distribution ? ` (${distribution})` : ""}`;
  if (answer.type === "choice") return `${id}: ${answer.choice ?? "?"} (confidence ${pct(answer.confidence)})${distribution ? ` [${distribution}]` : ""}`;
  const legend = answer.legend?.[String(Math.round(answer.score ?? 0))];
  return `${id}: score ${answer.score ?? "?"}${legend ? ` = ${legend}` : ""} (confidence ${pct(answer.confidence)})${distribution ? ` [${distribution}]` : ""}`;
}

export function createKevTool(settings: KevSettings): ToolDefinition {
  const client = new KevClient(settings);
  return {
    name: "kev_decide",
    description: "Ask a local Kev decision model (Jev-style System One) to choose among options you provide. Use it as a second opinion before a consequential or ambiguous call: pass the relevant state and typed questions (noul yes/no, choice among named options, score across ordered levels) and read back calibrated probabilities and a confidence. Kev reads only the state you pass and cannot use tools.",
    risk: "network",
    parameters: {
      type: "object",
      properties: {
        state: { type: "string", description: "The evidence the decision is made against: the task, the candidate options, relevant code or facts." },
        questions: {
          type: "object",
          description: "Question id -> question. noul: {type}. choice: {type, instructions, options: {name: description|null}}. score: {type, instructions, options: [level, ...]}.",
          additionalProperties: {
            type: "object",
            properties: {
              type: { type: "string", enum: ["noul", "choice", "score"] },
              instructions: { type: "string" },
              options: { description: "choice: object name -> description; score: ordered array of level descriptions" },
            },
            required: ["type"],
            additionalProperties: false,
          },
        },
        model: { type: "string", description: "Optional model name; defaults to the configured checkpoint." },
      },
      required: ["state", "questions"],
      additionalProperties: false,
    },
    async execute(args, signal) {
      const questions = parseKevQuestions(args.questions);
      const state = typeof args.state === "string" ? args.state : "";
      const response = await client.decide(state, questions, signal);
      const lines = Object.entries(questions).map(([id]) => {
        const answer = response.answers[id];
        return answer ? describeAnswer(id, answer) : `${id}: (no answer returned)`;
      });
      const meta = [response.model && `model ${response.model}`, response.latency_ms !== undefined && `${response.latency_ms}ms`,
        response.truncated && "state was truncated by the server"].filter(Boolean).join(" · ");
      return `${lines.join("\n")}${meta ? `\n(${meta})` : ""}\n\nFull JSON:\n${JSON.stringify(response, null, 2)}`;
    },
  };
}
