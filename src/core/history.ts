import type { ChatMessage, ToolCall } from "./types.js";

/** Close interrupted tool batches without replaying potentially completed effects. */
export function repairToolHistory(messages: ChatMessage[]): void {
  const repaired: ChatMessage[] = [];
  let pending = new Map<string, ToolCall>();
  const flush = () => {
    for (const call of pending.values()) repaired.push({
      role: "tool", name: call.function.name, tool_call_id: call.id,
      content: "TOOL ERROR: interrupted before a result was recorded. Execution status is unknown; inspect current state before retrying.",
    });
    pending.clear();
  };
  for (const message of messages) {
    if (message.role === "tool") {
      if (!message.tool_call_id || !pending.has(message.tool_call_id)) continue;
      pending.delete(message.tool_call_id);
      repaired.push(message);
      continue;
    }
    flush();
    repaired.push(message);
    pending = new Map(message.tool_calls?.map((call) => [call.id, call]) ?? []);
  }
  flush();
  messages.splice(0, messages.length, ...repaired);
}
