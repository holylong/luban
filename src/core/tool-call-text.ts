import type { ToolCall } from "./types.js";

/**
 * Recover tool calls a provider returned as text.
 *
 * Some OpenAI-compatible gateways do not translate DeepSeek's XML-style tool
 * call syntax into `tool_calls`, so the model's intent arrives as assistant
 * content wrapped in special-token delimiters:
 *
 *   <｜｜DSML｜｜ calls>
 *   <｜｜DSML｜｜ invoke name="bash">
 *   <｜｜DSML｜ parameter name="command" string="true">ls -la</｜｜DSML｜｜ parameter>
 *   </｜｜DSML｜｜ invoke>
 *   </｜｜DSML｜｜ calls>
 *
 * Luban used to print that markup as an answer and never run the tool, so the
 * model believed it had acted and the user had to notice by hand. This turns
 * the recognised blocks back into real calls and strips them from the prose.
 * The delimiter text is matched loosely (any token id, `tool_calls` or `calls`)
 * so a different gateway build still parses.
 */
const CALLS_BLOCK = /<｜[^>]*?calls\s*>[\s\S]*?<\/｜[^>]*?calls\s*>/gu;
const INVOKE = /<｜[^>]*?invoke\s+name="([^"]*)"[^>]*>([\s\S]*?)<\/｜[^>]*?invoke\s*>/gu;
const PARAMETER = /<｜[^>]*?parameter\s+name="([^"]*)"([^>]*)>([\s\S]*?)<\/｜[^>]*?parameter\s*>/gu;

export interface RecoveredText {
  /** Prose with the recovered call markup removed. */
  content: string;
  /** Calls parsed from the markup; empty when the text held none. */
  toolCalls: ToolCall[];
}

function parseArguments(body: string): Record<string, unknown> {
  const args: Record<string, unknown> = {};
  for (const match of body.matchAll(PARAMETER)) {
    const [, name, attributes, value] = match;
    if (!name) continue;
    // `string="true"` means the value is literal text (a shell command, a path);
    // otherwise it is JSON, and a value that fails to parse stays a string.
    if (/\bstring="true"/u.test(attributes ?? "")) args[name] = value;
    else {
      try { args[name] = JSON.parse(value ?? ""); } catch { args[name] = value; }
    }
  }
  return args;
}

export function recoverTextToolCalls(content: string): RecoveredText {
  if (!content.includes("<｜")) return { content, toolCalls: [] };
  const blocks = [...content.matchAll(CALLS_BLOCK)];
  if (!blocks.length) return { content, toolCalls: [] };
  const toolCalls: ToolCall[] = [];
  for (const block of blocks) {
    for (const invoke of block[0].matchAll(INVOKE)) {
      const name = invoke[1];
      if (!name) continue;
      toolCalls.push({
        id: `text-call-${toolCalls.length}`,
        type: "function",
        function: { name, arguments: JSON.stringify(parseArguments(invoke[2] ?? "")) },
      });
    }
  }
  if (!toolCalls.length) return { content, toolCalls: [] };
  const cleaned = content.replace(CALLS_BLOCK, "").replace(/\n{3,}/gu, "\n\n").trim();
  return { content: cleaned, toolCalls };
}
