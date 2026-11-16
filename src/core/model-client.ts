import type { LubanConfig } from "./types.js";
import { OpenAiClient } from "./openai.js";
import { AnthropicClient } from "./anthropic.js";
import { ResponsesClient } from "./responses.js";
import { CodexBackendClient, type CompletionClient } from "./codex-backend.js";
import { isZenFreeModel, OpenCodeZenClient } from "./opencode-zen.js";

export type ModelClient = CompletionClient;

/**
 * One place decides which wire protocol serves a model. Codex keeps its ChatGPT
 * login but talks to the backend directly without automatic CLI fallback.
 * Only an explicit `LUBAN_CODEX_MODE=cli` selects the official CLI.
 */
export function modelClientFor(config: LubanConfig): ModelClient {
  if (isZenFreeModel(config.model)) return new OpenCodeZenClient(config);
  switch (config.model.api) {
    case "codex": return new CodexBackendClient(config);
    case "anthropic": return new AnthropicClient(config);
    case "responses": return new ResponsesClient(config);
    default: return new OpenAiClient(config);
  }
}
