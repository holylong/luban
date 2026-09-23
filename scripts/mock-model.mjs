/**
 * Minimal OpenAI-compatible model used by the local smoke tests.
 *
 * Default behaviour: the first completion asks for a `write_file` call, every
 * later completion streams a short answer token by token. That exercises the
 * real tool loop, the inline edit record and the streaming transcript without
 * any paid API call.
 *
 * Environment knobs used by the TUI scroll test:
 *   MOCK_TOOL        tool to call before answering (default write_file)
 *   MOCK_TOOL_STEPS  how many tool calls to make first (default 1)
 *   MOCK_DELAY_MS    pause before each completion, so a run is observable
 *                    while it is still in flight (default 0)
 *   MOCK_STREAM_TOKENS  length of the final streamed answer, in small deltas
 *   MOCK_THINKING   emit reasoning deltas first, so the live line can be seen
 *   MOCK_FAIL_TIMES answer the first N requests with HTTP 429, so the retry
 *                   notice is exercised without a flaky provider
 *   MOCK_SILENCE_MS accept the request, send headers, then stay quiet for this
 *                   long before the first chunk: the realistic stall that the
 *                   client's idle watchdog has to notice and explain
 *   MOCK_SILENCE_TIMES  how many requests stall (default 1 when set)
 *   MOCK_TOOL_SLEEP_MS  make the shell tool itself take this long, so the
 *                   "running a tool" phase is observable
 *   MOCK_HANDOFF    "peer|instruction": delegate the task over the mesh instead
 *                   of doing the work, so a remote job can be observed
 *   MOCK_PLAN       1 = publish a task plan before touching anything
 *   MOCK_TRUNCATE_TIMES  cut the first N answers off at the output limit
 *                   (finish_reason "length"), the way a provider cap does
 *
 * Usage: node scripts/mock-model.mjs [port]
 */
import { createServer } from "node:http";

const port = Number(process.argv[2] || 8899);
const handoff = (process.env.MOCK_HANDOFF || "").split("|");
const planFirst = process.env.MOCK_PLAN === "1";
const truncateTimes = Math.max(0, Number(process.env.MOCK_TRUNCATE_TIMES || 0));
// Delegating is expressed as the tool, so the mock never does the work itself.
const tool = process.env.MOCK_TOOL || (handoff.length > 1 ? "mesh_handoff" : "write_file");
const steps = Math.max(1, Number(process.env.MOCK_TOOL_STEPS || 1));
const delayMs = Math.max(0, Number(process.env.MOCK_DELAY_MS || 0));
const streamTokens = Math.max(0, Number(process.env.MOCK_STREAM_TOKENS || 0));
const thinking = process.env.MOCK_THINKING === "1";
const paceMs = Math.max(0, Number(process.env.MOCK_PACE_MS || 0));
const silenceMs = Math.max(0, Number(process.env.MOCK_SILENCE_MS || 0));
const silenceTimes = Math.max(0, Number(process.env.MOCK_SILENCE_TIMES || (silenceMs ? 1 : 0)));
const failTimes = Math.max(0, Number(process.env.MOCK_FAIL_TIMES || 0));
const toolSleepMs = Math.max(0, Number(process.env.MOCK_TOOL_SLEEP_MS || 0));
let turn = 0;
let failures = 0;
let silences = 0;
let truncations = 0;

const sse = async (res, chunks, paceMs = 0, firstByteMs = 0) => {
  res.writeHead(200, {
    "content-type": "text/event-stream; charset=utf-8",
    "cache-control": "no-cache",
    connection: "keep-alive",
  });
  // Flush first: a provider that stalls mid-request has already returned 200,
  // which is exactly the case the idle watchdog exists for.
  res.flushHeaders?.();
  if (firstByteMs) await new Promise(resolve => setTimeout(resolve, firstByteMs));
  for (const chunk of chunks) {
    res.write(`data: ${JSON.stringify(chunk)}\n\n`);
    // A real model streams over seconds; pacing makes streaming behaviour
    // observable instead of arriving as one instant burst.
    if (paceMs) await new Promise(resolve => setTimeout(resolve, paceMs));
  }
  res.write("data: [DONE]\n\n");
  res.end();
};

const fragment = (delta, finish = null) => ({
  id: "chatcmpl-mock", object: "chat.completion.chunk", created: Math.floor(Date.now() / 1000),
  model: "mock-model", choices: [{ index: 0, delta, finish_reason: finish }],
});

function toolArguments(index) {
  if (tool === "mesh_handoff") {
    return JSON.stringify({ peer: handoff[0] || "", instruction: handoff[1] || "", timeout: 300 });
  }
  if (tool === "bash") {
    // Multi-line output so the collapsed execution timeline has real rows.
    const lines = Array.from({ length: 5 }, (_, line) => `line-${index}-${line}`).join("\\n");
    const lead = toolSleepMs ? `sleep ${(toolSleepMs / 1000).toFixed(2)}; ` : "";
    return JSON.stringify({ command: `${lead}printf '${lines}\\n'` });
  }
  return JSON.stringify({ path: "README.md", content: "# demo\n\nhello **world**\n\nAdded by the mock model run.\n" });
}

createServer(async (req, res) => {
  if (!req.url?.endsWith("/chat/completions")) { res.writeHead(404).end(); return; }
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  const body = JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
  if (delayMs) await new Promise(resolve => setTimeout(resolve, delayMs));
  const toolResults = (body.messages || []).filter(message => message.role === "tool").length;
  turn += 1;
  if (failures < failTimes) {
    failures += 1;
    res.writeHead(429, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: { message: "mock rate limit" } }));
    return;
  }
  console.log(JSON.stringify({
    turn, model: body.model, toolResults, tool, steps,
    lastTool: (body.messages || []).filter(message => message.role === "tool").map(message => String(message.content).slice(0, 160)).at(-1),
  }));

  // The plan is published as its own round trip, the way a real agent does it.
  if (planFirst && turn === 1) {
    await sse(res, [
      fragment({ role: "assistant", content: "" }),
      fragment({ tool_calls: [{ index: 0, id: "call-plan", type: "function", function: { name: "update_plan", arguments: "" } }] }),
      fragment({ tool_calls: [{ index: 0, function: { arguments: JSON.stringify({
        explanation: "mock plan",
        plan: [{ step: "检查仓库", status: "in_progress" }, { step: "运行测试", status: "pending" }],
      }) } }] }),
      fragment({}, "tool_calls"),
    ], paceMs);
    return;
  }

  if (toolResults < steps) {
    // write_file takes path+content; edit_file would need old_text/new_text.
    const callId = `call-${toolResults + 1}`;
    const toolStall = silences < silenceTimes ? (silences += 1, silenceMs) : 0;
    await sse(res, [
      fragment({ role: "assistant", content: "" }),
      fragment({ tool_calls: [{ index: 0, id: callId, type: "function", function: { name: tool, arguments: "" } }] }),
      fragment({ tool_calls: [{ index: 0, function: { arguments: toolArguments(toolResults + 1) } }] }),
      fragment({}, "tool_calls"),
    ], paceMs, toolStall);
    return;
  }

  const base = "I updated **README.md** and verified the change.\n\n```ts\nexport const answer = 43;\n```\n";
  const answer = streamTokens ? base + `\n${"streamed token payload. ".repeat(Math.ceil(streamTokens / 4))}` : base;
  const pieces = answer.match(/[\s\S]{1,12}/gu) ?? [];
  const reasoning = thinking
    ? ["Looking at the repository. ", "I should check README.md first. ", "The change is small. ", "I will write the file. "]
        .flatMap(line => line.match(/[\s\S]{1,6}/gu) ?? []).map(part => fragment({ reasoning_content: part }))
    : [];
  if (truncations < truncateTimes) {
    truncations += 1;
    const cut = Math.max(1, Math.floor(pieces.length / 2));
    await sse(res, [
      fragment({ role: "assistant", content: "" }),
      ...pieces.slice(0, cut).map(piece => fragment({ content: piece })),
      fragment({}, "length"),
    ], paceMs);
    return;
  }
  const stall = silences < silenceTimes ? (silences += 1, silenceMs) : 0;
  await sse(res, [
    fragment({ role: "assistant", content: "" }),
    ...reasoning,
    ...pieces.map(piece => fragment({ content: piece })),
    fragment({}, "stop"),
  ], paceMs, stall);
}).listen(port, "127.0.0.1", () => console.log(`mock model on http://127.0.0.1:${port}/v1 (${steps}x ${tool})`));
