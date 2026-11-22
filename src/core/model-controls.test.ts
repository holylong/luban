import { expect, it } from "vitest";
import { modelThinkingFields, reasoningRecoveryOptions } from "./model-controls.js";
import { loadConfig } from "./config.js";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AnthropicClient } from "./anthropic.js";
import { ResponsesClient } from "./responses.js";
import type { LubanConfig, ModelRef } from "./types.js";
const config = (model: Partial<ModelRef>) => ({ model: { id: "test/model", provider: "test", model: "test", name: "test", apiKey: "", baseUrl: "https://example.test/v1", ...model }, maxTokens: 8000, timeoutMs: 5000, maxRetries: 3, temperature: 0.2 } as LubanConfig);
it.each([
  [{ model: "gpt-5", api: "responses" }, { reasoning: { effort: "low" } }],
  [{ model: "claude-sonnet-4-6", api: "anthropic" }, { thinking: { type: "disabled" } }],
  [{ id: "test/qwen3", api: "openai" }, { chat_template_kwargs: { enable_thinking: false } }],
] as const)("uses the native recovery control for %j without changing preferences", (model, expected) => {
  const settings = config(model);
  settings.enableThinking = true;
  const recovery = reasoningRecoveryOptions(settings, { enableThinking: true }, 8000);
  expect(recovery).toBeDefined();
  expect(modelThinkingFields(settings, recovery, 8000)).toEqual(expected);
  expect(settings.enableThinking).toBe(true);
});

it("requires a real wire change and does not override Codex CLI or explicit output limits", () => {
  const unknown = config({ thinkingControl: "none" });
  expect(reasoningRecoveryOptions(unknown, { enableThinking: false }, 8000)).toBeUndefined();
  // The caller clamps to the hard ceiling first, so a larger budget is the change.
  expect(reasoningRecoveryOptions(unknown, { maxTokens: 2000 }, 32000)?.maxTokens).toBe(32000);
  expect(reasoningRecoveryOptions(unknown, { maxTokens: 32000 }, 32000)).toBeUndefined();
  expect(reasoningRecoveryOptions(config({ api: "codex" }), { maxTokens: 2000 }, 8000)).toBeUndefined();
});
it("scales the request timeout with the raised output budget", () => {
  const unknown = config({ thinkingControl: "none" });
  expect(reasoningRecoveryOptions(unknown, { maxTokens: 2000, timeoutMs: 5000 }, 32000)?.timeoutMs).toBe(20000);
  expect(reasoningRecoveryOptions(unknown, { maxTokens: 250, timeoutMs: 5000 }, 32000)?.timeoutMs).toBe(20000);
});
it("uses native controls and permits explicit gateway overrides", () => {
  expect(modelThinkingFields(config({ id: "test/qwen3" }), { enableThinking: false }, 8000)).toEqual({ chat_template_kwargs: { enable_thinking: false } });
  expect(modelThinkingFields(config({ model: "deepseek-v4-flash" }), { enableThinking: true }, 8000)).toEqual({ thinking: { type: "enabled" } });
  // The plain "deepseek-flash" alias also thinks by default, so it has to be
  // switchable; deepseek-chat has no thinking mode and must stay untouched.
  expect(modelThinkingFields(config({ model: "deepseek-flash" }), { enableThinking: false }, 8000)).toEqual({ thinking: { type: "disabled" } });
  expect(modelThinkingFields(config({ model: "deepseek-flash" }), {}, 8000)).toEqual({});
  expect(modelThinkingFields(config({ model: "deepseek-chat" }), { enableThinking: false }, 8000)).toEqual({});
  expect(modelThinkingFields(config({ model: "gpt-5", api: "responses" }), { enableThinking: false }, 8000)).toEqual({ reasoning: { effort: "low" } });
  expect(modelThinkingFields(config({ model: "claude-sonnet-4-6", api: "anthropic" }), { enableThinking: true }, 8000)).toEqual({ thinking: { type: "adaptive" } });
  expect(modelThinkingFields(config({ model: "claude-sonnet-4-5", api: "anthropic" }), { enableThinking: true }, 3000)).toEqual({ thinking: { type: "enabled", budget_tokens: 1500 } });
  expect(modelThinkingFields(config({ model: "claude-sonnet-4-5", api: "anthropic" }), { enableThinking: true }, 1000)).toEqual({});
  expect(modelThinkingFields(config({}), { enableThinking: true }, 8000)).toEqual({});
  expect(modelThinkingFields(config({ thinkingControl: "none" }), { enableThinking: true }, 8000)).toEqual({});
  expect(modelThinkingFields(config({ thinkingControl: "thinking" }), { enableThinking: false }, 8000)).toEqual({ thinking: { type: "disabled" } });
});
it.each(["anthropic", "responses"] as const)("applies per-request output and reasoning options in %s", async api => {
  const settings = config({ model: api === "anthropic" ? "claude-sonnet-4-6" : "gpt-5", api });
  const client = api === "anthropic" ? new AnthropicClient(settings) : new ResponsesClient(settings);
  const original = globalThis.fetch;
  let body: Record<string, unknown> = {};
  globalThis.fetch = async (_url, init) => {
    body = JSON.parse(String(init?.body));
    return new Response(JSON.stringify(api === "anthropic" ? { content: [{ type: "text", text: "done" }], usage: {} } : { output: [], usage: {} }), { headers: { "content-type": "application/json" } });
  };
  try {
    await client.complete([{ role: "user", content: "inspect" }], [], new AbortController().signal, undefined, undefined, { maxTokens: 2000, enableThinking: false, maxRetries: 0, timeoutMs: 1000 });
    expect(body[api === "anthropic" ? "max_tokens" : "max_output_tokens"]).toBe(2000);
    expect(body[api === "anthropic" ? "thinking" : "reasoning"]).toEqual(api === "anthropic" ? { type: "disabled" } : { effort: "low" });
  } finally { globalThis.fetch = original; }
});
it.each(["anthropic", "responses"] as const)("does not retry when a %s request overrides retries to zero", async api => {
  const settings = config({ api });
  const client = api === "anthropic" ? new AnthropicClient(settings) : new ResponsesClient(settings);
  const original = globalThis.fetch; let calls = 0;
  globalThis.fetch = async () => { calls++; return new Response("busy", { status: 503 }); };
  try {
    await expect(client.complete([{ role: "user", content: "inspect" }], [], new AbortController().signal, undefined, undefined, { maxRetries: 0 })).rejects.toThrow();
    expect(calls).toBe(1);
  } finally { globalThis.fetch = original; }
});

it("lets a one-off flag turn native thinking off without editing the config file", () => {
  const home = mkdtempSync(join(tmpdir(), "luban-thinking-"));
  writeFileSync(join(home, "config.json"), JSON.stringify({ model: { provider: "deepseek", model: "deepseek-flash", max_tokens: 128000, thinking: true } }));
  const env = { ...process.env };
  process.env.LUBAN_HOME = home;
  try {
    expect(loadConfig({ workspace: home }).enableThinking).toBe(true);
    expect(loadConfig({ workspace: home, thinking: "off" }).enableThinking).toBe(false);
    expect(loadConfig({ workspace: home, thinking: "on" }).enableThinking).toBe(true);
    expect(loadConfig({ workspace: home, thinking: "auto" }).enableThinking).toBe(true);
  } finally {
    process.env.LUBAN_HOME = env.LUBAN_HOME;
    if (env.LUBAN_HOME === undefined) delete process.env.LUBAN_HOME;
  }
});
