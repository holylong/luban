import type { LubanConfig, ModelRef } from "./types.js";
import type { ModelRequestOptions } from "./openai.js";

/** Recovery must change what the provider actually receives. Unknown models
 * may ignore thinking options, so only a real budget increase helps those. */
export function reasoningRecoveryOptions(config: LubanConfig, current: ModelRequestOptions | undefined,
  outputLimit: number): ModelRequestOptions | undefined {
  if (config.model.api === "codex") return undefined;
  const maxTokens = Math.min(config.maxTokens, outputLimit);
  const previousMax = Math.min(current?.maxTokens ?? config.maxTokens, maxTokens);
  const next: ModelRequestOptions = {
    ...current, maxTokens, enableThinking: false, reasoningEffort: "low",
    timeoutMs: config.timeoutMs,
    thinkingTimeoutMs: config.thinkingTimeoutMs ?? Math.max(config.timeoutMs, 600_000),
    maxRetries: config.maxRetries ?? 3,
  };
  const previousFields = modelThinkingFields(config, current, previousMax);
  const nextFields = modelThinkingFields(config, next, maxTokens);
  return maxTokens > previousMax || JSON.stringify(previousFields) !== JSON.stringify(nextFields) ? next : undefined;
}

/** Send native controls only for recognized models or an explicit gateway override. */
export function modelThinkingFields(config: LubanConfig, options: ModelRequestOptions | undefined, maxTokens: number): Record<string, unknown> {
  const model = config.model;
  const enabled = options?.enableThinking ?? config.enableThinking;
  const effort = options?.reasoningEffort ?? (enabled === false ? "low" : model.reasoningEffort ?? "medium");
  let control: ModelRef["thinkingControl"] = model.thinkingControl;
  if (!control) {
    if (/qwen/iu.test(model.id)) control = "qwen";
    else if (/deepseek-(?:v[34]|chat|reasoner)/iu.test(model.model)) control = "thinking";
    else if (model.api === "anthropic" && /claude/iu.test(model.model)) {
      control = /(?:opus|sonnet)[-.]4[-.]?[6-9]|claude[-.]?[5-9]/iu.test(model.model) ? "adaptive" : "budget";
    } else if (/^(?:gpt-[56]|o[134])(?:[-.]|$)/iu.test(model.model)) control = "reasoning-effort";
    else if (config.enableThinking !== undefined && model.api !== "responses" && model.api !== "anthropic") control = "qwen";
  }
  if (control === "reasoning-effort") {
    if (enabled === undefined && !model.reasoningEffort && !options?.reasoningEffort) return {};
    return model.api === "responses" ? { reasoning: { effort } } : { reasoning_effort: effort };
  }
  if (enabled === undefined || control === "none") return {};
  if (control === "qwen") return { chat_template_kwargs: { enable_thinking: enabled } };
  if (control === "thinking") return { thinking: { type: enabled ? "enabled" : "disabled" } };
  if (control === "adaptive") return { thinking: { type: enabled ? "adaptive" : "disabled" } };
  if (control === "budget") {
    if (!enabled) return { thinking: { type: "disabled" } };
    if (maxTokens <= 1024) return {};
    return { thinking: { type: "enabled", budget_tokens: Math.max(1024, Math.min(16_384, Math.floor(maxTokens / 2), maxTokens - 1)) } };
  }
  return {};
}
