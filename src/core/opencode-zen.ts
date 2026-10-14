import { randomBytes } from "node:crypto";
import { VERSION } from "../version.js";
import { OpenAiClient, type CompletionResult, type DeltaHandler, type NoticeHandler, type ModelRequestOptions } from "./openai.js";
import { ResponsesClient } from "./responses.js";
import type { ChatMessage, LubanConfig, ModelRef } from "./types.js";

// Zen checks the OpenCode wire protocol version and session format, as well as
// the coding tools in the payload. Keep luban attribution in both headers.
const WIRE_VERSION = "1.19.0";
const TOOL_NAMES: Record<string, string> = {
  read_file: "read", write_file: "write", edit_file: "edit",
  glob_files: "glob", grep_files: "grep", list_dir: "ls",
};

export function isZenFreeModel(model: ModelRef): boolean {
  return model.provider === "opencode-zen" && /-free$|^big-pickle$/.test(model.model);
}

/** OpenCode v1 descending session ID: six timestamp bytes and fourteen base62 bytes. */
function sessionID(): string {
  const timestamp = ~(BigInt(Date.now()) * 0x1000n);
  const time = Array.from({ length: 6 }, (_, index) =>
    Number((timestamp >> BigInt(40 - 8 * index)) & 0xffn).toString(16).padStart(2, "0")).join("");
  const chars = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";
  return `ses_${time}${Array.from(randomBytes(14), byte => chars[byte % 62]).join("")}`;
}

/** Translate real luban tools on the wire, then restore their names before execution. */
export class OpenCodeZenClient {
  private readonly client: OpenAiClient | ResponsesClient;

  constructor(config: LubanConfig) {
    const session = sessionID();
    const headers = new Headers({
      "user-agent": `opencode/${WIRE_VERSION} luban/${VERSION}`,
      "x-opencode-client": "luban",
      "x-opencode-session": session,
      "x-opencode-session-id": session,
    });
    for (const [name, value] of Object.entries(config.model.headers ?? {})) headers.set(name, value);
    const wireConfig: LubanConfig = { ...config, model: {
      ...config.model,
      apiKey: config.model.apiKey || "public",
      headers: Object.fromEntries(headers),
    } };
    this.client = config.model.api === "responses" ? new ResponsesClient(wireConfig) : new OpenAiClient(wireConfig);
  }

  async complete(messages: ChatMessage[], tools: Array<Record<string, unknown>>, signal: AbortSignal,
    onDelta?: DeltaHandler, onNotice?: NoticeHandler, options?: ModelRequestOptions): Promise<CompletionResult> {
    const existing = new Set(tools.map(tool => (tool.function as Record<string, unknown>).name));
    const aliases = Object.fromEntries(Object.entries(TOOL_NAMES).filter(([name, alias]) => existing.has(name) && !existing.has(alias)));
    const nativeNames = Object.fromEntries(Object.entries(aliases).map(([name, alias]) => [alias, name]));
    const wireMessages = messages.map(message => ({ ...message,
      ...(message.name ? { name: aliases[message.name] ?? message.name } : {}),
      ...(message.tool_calls ? { tool_calls: message.tool_calls.map(call => ({ ...call,
        function: { ...call.function, name: aliases[call.function.name] ?? call.function.name },
      })) } : {}),
    }));
    const wireTools = tools.map(tool => {
      const fn = tool.function as Record<string, unknown>;
      return { ...tool, function: { ...fn, name: aliases[String(fn.name)] ?? fn.name } };
    });
    const result = await this.client.complete(wireMessages, wireTools, signal, onDelta, onNotice, options);
    return { ...result, toolCalls: result.toolCalls.map(call => ({ ...call,
      function: { ...call.function, name: nativeNames[call.function.name] ?? call.function.name },
    })) };
  }
}
