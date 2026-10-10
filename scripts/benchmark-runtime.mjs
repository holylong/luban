// Run after npm run build. No model requests or workspace writes are made.
import { performance } from "node:perf_hooks";
import { codeIntelligenceTool } from "../dist/core/code-intelligence.js";
import { compactMessages, compactForRequest, estimateMessagesTokens } from "../dist/core/context.js";
const results = {};
for (const [name, compact] of [["messageLimit", compactMessages], ["tokenPressure", compactForRequest]]) {
  let messages = [{ role: "system", content: "rules" }, { role: "user", content: "task" }];
  let compactions = 0;
  for (let index = 0; index < 50; index++) {
    messages.push({ role: "assistant", content: "", tool_calls: [{ id: String(index), type: "function", function: { name: "bash", arguments: "{}" } }] },
      { role: "tool", name: "bash", tool_call_id: String(index), content: "small result ".repeat(60) });
    const result = compact(messages, 229_376, 60);
    if (result.messages !== messages) compactions++;
    messages = result.messages;
  }
  results[name] = { compactions, messages: messages.length, estimatedTokens: estimateMessagesTokens(messages) };
}
const tool = codeIntelligenceTool(process.cwd());
results.codeIntelligence = [];
try {
  for (const operation of ["symbols", "symbols", "symbols", "diagnostics", "diagnostics"]) {
    const start = performance.now();
    const result = JSON.parse(await tool.execute({ path: process.argv[2] ?? "src/core/agent.ts", operation, timeout_ms: 10_000 }, new AbortController().signal));
    results.codeIntelligence.push({ operation, elapsedMs: Math.round(performance.now() - start), results: result.total });
  }
} finally { tool.close?.(); }
process.stdout.write(`${JSON.stringify(results, null, 2)}\n`);
