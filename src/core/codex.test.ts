import { afterEach, describe, expect, it } from "vitest";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig, savePreferredModel } from "./config.js";
import { CodexClient } from "./codex.js";
import { AgentRunner, initialMessages } from "./agent.js";
import { planTools } from "./plan.js";
import type { ChatMessage } from "./types.js";

async function recordingClient() {
  const home = await mkdtemp(join(tmpdir(), "luban-codex-recording-"));
  process.env.LUBAN_HOME = home;
  const log = join(home, "requests.jsonl");
  const fake = join(home, "codex");
  await writeFile(fake, `#!/usr/bin/env node
const fs = require('fs');
const args = process.argv.slice(2);
let input = '';
process.stdin.on('data', chunk => input += chunk);
process.stdin.on('end', () => {
  const images = args.flatMap((arg, i) => arg === '--image' ? [fs.readFileSync(args[i + 1], 'base64')] : []);
  fs.appendFileSync(${JSON.stringify(log)}, JSON.stringify({args, input, images}) + '\\n');
  if (!args.includes('--json') || args.includes('--ephemeral')) process.exit(9);
  const failureFile = ${JSON.stringify(join(home, "failed-once"))};
  if (input.includes('FAIL_THIS_TURN') && !fs.existsSync(failureFile)) { fs.writeFileSync(failureFile, '1'); process.exit(7); }
  if (input.includes('NETWORK_ONCE') && !fs.existsSync(failureFile)) { fs.writeFileSync(failureFile, '1'); process.stderr.write('stream disconnected before completion'); process.exit(1); }
  if (input.includes('ACTIVE_THIS_TURN')) {
    const pulse = setInterval(() => process.stdout.write(JSON.stringify({type:'item.updated'}) + String.fromCharCode(10)), 100);
    setTimeout(() => { clearInterval(pulse); fs.writeFileSync(args[args.indexOf('--output-last-message') + 1], JSON.stringify({content:'done', tool_calls:[]})); }, 1500);
    return;
  }
  if (input.includes('IGNORE_TERM')) {
    process.on('SIGTERM', () => {});
    fs.writeFileSync(${JSON.stringify(join(home, 'child-pid'))}, String(process.pid));
    return setInterval(() => {}, 1000);
  }
  if (input.includes('WAIT_THIS_TURN')) return setInterval(() => {}, 1000);
  const id = args.includes('resume') ? args[args.indexOf('resume') + 1] : require('crypto').randomUUID();
  const started = JSON.stringify({type: 'thread.started', thread_id: id}) + '\\n';
  process.stdout.write(started.slice(0, 11));
  process.stdout.write(started.slice(11));
  const output = args[args.indexOf('--output-last-message') + 1];
  const response = {content:'done', tool_calls:[]};
  const mode = input.match(/OUTPUT_MODE:([a-z-]+)/)?.[1];
  const missingMarker = ${JSON.stringify(join(home, 'missing-once'))};
  const skipOnce = input.includes('MISSING_ONCE') && !fs.existsSync(missingMarker);
  if (skipOnce) fs.writeFileSync(missingMarker, '1');
  if (!skipOnce && !['missing', 'event', 'partial', 'failed', 'invalid-event', 'empty', 'invalid', 'malformed-call'].includes(mode)) fs.writeFileSync(output, JSON.stringify(response));
  if (mode === 'empty') fs.writeFileSync(output, '');
  if (mode === 'invalid') fs.writeFileSync(output, '{broken');
  if (mode === 'malformed-call') fs.writeFileSync(output, JSON.stringify({content:'', tool_calls:[null]}));
  if (['event', 'partial', 'failed', 'invalid-event'].includes(mode)) {
    const text = mode === 'invalid-event' ? 'not JSON' : JSON.stringify(response);
    const event = JSON.stringify({type:'item.completed', item:{type:'agent_message', text}}) + String.fromCharCode(10);
    process.stdout.write(event.slice(0, 17));
    process.stdout.write(event.slice(17));
    if (mode === 'partial') return;
    if (mode === 'failed') { process.stdout.write(JSON.stringify({type:'turn.failed', error:{message:'authentication required'}})); return; }
  }
  const usageFile = ${JSON.stringify(join(home, "thread-usage.json"))};
  const counts = fs.existsSync(usageFile) ? JSON.parse(fs.readFileSync(usageFile, 'utf8')) : {};
  const count = counts[id] = (counts[id] || 0) + 1;
  fs.writeFileSync(usageFile, JSON.stringify(counts));
  process.stdout.write(JSON.stringify({type:'turn.completed', usage:{input_tokens:120*count, cached_input_tokens:100*count, output_tokens:30*count, reasoning_output_tokens:20*count}}));
});
`, { mode: 0o755 });
  process.env.LUBAN_CODEX_BIN = fake;
  await savePreferredModel(home, "codex/gpt-6.1-sol", "medium");
  const config = loadConfig({ workspace: home, model: "codex/gpt-6.1-sol" });
  const requests = async () => (await readFile(log, "utf8")).trim().split("\n")
    .map(line => JSON.parse(line) as { args: string[]; input: string; images: string[] });
  return { client: new CodexClient(config), config, requests };
}

const originalBin = process.env.LUBAN_CODEX_BIN;
const originalHome = process.env.LUBAN_HOME;
afterEach(() => {
  if (originalBin === undefined) delete process.env.LUBAN_CODEX_BIN;
  else process.env.LUBAN_CODEX_BIN = originalBin;
  if (originalHome === undefined) delete process.env.LUBAN_HOME;
  else process.env.LUBAN_HOME = originalHome;
});

describe("CodexClient", () => {
  const png = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==";

  it("sends native image bytes initially and on resume, then accepts text-only follow-ups", async () => {
    const { client, config, requests } = await recordingClient();
    await writeFile(join(config.workspace, "截图 with spaces.png"), Buffer.from(png, "base64"));
    const image = { path: "截图 with spaces.png", mime: "image/png" };
    const messages: ChatMessage[] = [{ role: "user", content: "inspect screenshot", images: [image] }];
    const signal = new AbortController().signal;
    await client.complete(messages, [], signal);
    messages.push({ role: "assistant", content: "done" }, { role: "user", content: "another screenshot", images: [image] });
    await client.complete(messages, [], signal);
    messages.push({ role: "assistant", content: "done" }, { role: "user", content: "continue in text" });
    await client.complete(messages, [], signal);
    const recorded = await requests();
    expect(recorded.map(request => request.images)).toEqual([[png], [png], []]);
    expect(recorded.map(request => request.args.includes("resume"))).toEqual([false, true, true]);
    expect(recorded[0]!.input).toContain("Native image attachments");
    expect(recorded[1]!.input).not.toContain("inspect screenshot");
    for (const request of recorded.slice(0, 2)) {
      await expect(readFile(request.args[request.args.indexOf("--image") + 1]!)).rejects.toThrow();
    }
  });

  it("detects tool-attached images on an earlier user message and rebuilds the thread", async () => {
    const { client, config, requests } = await recordingClient();
    await writeFile(join(config.workspace, "shot.png"), Buffer.from(png, "base64"));
    const messages: ChatMessage[] = [{ role: "user", content: "look" }];
    const signal = new AbortController().signal;
    await client.complete(messages, [], signal);
    messages[0]!.images = [{ path: "shot.png", mime: "image/png" }];
    messages.push({ role: "assistant", content: "attaching" }, { role: "tool", content: "attached" });
    await client.complete(messages, [], signal);
    const recorded = await requests();
    expect(recorded[1]!.args).not.toContain("resume");
    expect(recorded[1]!.images).toEqual([png]);
  });

  it("recovers after a failed image turn without removing images from history", async () => {
    const { client, config, requests } = await recordingClient();
    await writeFile(join(config.workspace, "shot.png"), Buffer.from(png, "base64"));
    const messages: ChatMessage[] = [{ role: "user", content: "FAIL_THIS_TURN", images: [{ path: "shot.png", mime: "image/png" }] }];
    const signal = new AbortController().signal;
    await expect(client.complete(messages, [], signal)).rejects.toThrow("exit 7");
    messages.push({ role: "user", content: "continue" });
    await expect(client.complete(messages, [], signal)).resolves.toMatchObject({ content: "done" });
    expect((await requests()).map(request => request.images)).toEqual([[png], [png]]);
    expect(messages[0]!.images).toHaveLength(1);
  });

  it("skips unavailable historical attachments with a notice and continues the text request", async () => {
    const { client, requests } = await recordingClient();
    const notices: string[] = [];
    await expect(client.complete([
      { role: "user", content: "old screenshot", images: [{ path: "missing.png", mime: "image/png" }] },
      { role: "user", content: "new text" },
    ], [], new AbortController().signal, undefined, text => notices.push(text))).resolves.toMatchObject({ content: "done" });
    expect(notices.join("")).toContain("已跳过");
    expect((await requests())[0]!.images).toEqual([]);
  });

  it("resumes across TUI-style copied transcripts on consecutive user turns", async () => {
    const { client, config, requests } = await recordingClient();
    const runner = new AgentRunner(config, client);
    const messages: ChatMessage[] = [...initialMessages(config.workspace), { role: "user", content: "FIRST_USER_TASK" }];
    try {
      const result = await runner.run(messages, "agent", new AbortController().signal, () => undefined, async () => "once");
      const copied: ChatMessage[] = [...structuredClone(result.messages), { role: "user", content: "SECOND_USER_TASK" }];
      await runner.run(copied, "agent", new AbortController().signal, () => undefined, async () => "once");
      const [first, next] = await requests();
      expect(first!.args).not.toContain("resume");
      expect(next!.args).toContain("resume");
      expect(next!.input).toContain("SECOND_USER_TASK");
      expect(next!.input).not.toContain("FIRST_USER_TASK");
      expect(next!.input).not.toContain("Available luban tools");
    } finally { runner.close(); }
  });

  it("resumes after inserting or updating plans and sends the current authoritative state", async () => {
    const { client, requests } = await recordingClient();
    const messages: ChatMessage[] = [{ role: "system", content: "stable rules" }, { role: "user", content: "ORIGINAL_TASK" }];
    const tools = [{ name: "update_plan" }];
    const signal = new AbortController().signal;
    await client.complete(messages, tools, signal);
    messages.push({ role: "assistant", content: "done" });
    const update = planTools(messages).find(tool => tool.name === "update_plan")!;
    await update.execute({ plan: [{ step: "UNIQUE_PLAN_STEP", status: "in_progress" }] }, signal);
    messages.push({ role: "tool", content: "plan saved" });
    await client.complete(messages, tools, signal);
    await update.execute({ plan: [{ step: "UNIQUE_PLAN_STEP", status: "completed" }] }, signal);
    messages.push({ role: "tool", content: "plan completed" });
    await client.complete(messages, tools, signal);
    const recorded = await requests();
    expect(recorded.map(request => request.args.includes("resume"))).toEqual([false, true, true]);
    expect(recorded[1]!.input).toContain("UNIQUE_PLAN_STEP");
    const state = JSON.parse(recorded[2]!.input.split("\n\n")[2]!) as ChatMessage[];
    expect(state[0]!.content).toContain('"status":"completed"');
    expect(state[0]!.content).not.toContain('"status":"in_progress"');
    expect(recorded[1]!.input).not.toContain("ORIGINAL_TASK");
    expect(recorded[2]!.input).not.toContain("ORIGINAL_TASK");
    const verification = planTools(messages).find(tool => tool.name === "record_verification")!;
    await verification.execute({ command: "npm test", status: "passed" }, signal);
    messages.push({ role: "tool", content: "verification recorded" });
    await client.complete(messages, tools, signal);
    const checked = (await requests())[3]!;
    expect(checked.args).toContain("resume");
    const verifiedState = JSON.parse(checked.input.split("\n\n")[2]!) as ChatMessage[];
    expect(verifiedState.some(message => String(message.content).includes('"command":"npm test"'))).toBe(true);
    expect(checked.input).not.toContain("ORIGINAL_TASK");
  });

  it("isolates explicit conversations and resets a failed thread even after the transcript is copied", async () => {
    const { client, requests } = await recordingClient();
    const signal = new AbortController().signal;
    const messages: ChatMessage[] = [{ role: "user", content: "task" }];
    await client.complete(messages, [], signal, undefined, undefined, { conversationId: "main" });
    const other = [...messages, { role: "user" as const, content: "other task" }];
    await client.complete(other, [], signal, undefined, undefined, { conversationId: "other" });
    const copied = [...messages, { role: "tool" as const, content: "FAIL_THIS_TURN" }];
    await expect(client.complete(copied, [], signal, undefined, undefined, { conversationId: "main" })).rejects.toThrow("exit 7");
    copied.at(-1)!.content = "retry after failure";
    await client.complete([...copied], [], signal, undefined, undefined, { conversationId: "main" });
    expect((await requests()).map(request => request.args.includes("resume"))).toEqual([false, false, true, false]);
  });

  it("resumes the exact thread, sends only appended messages, and parses chunked usage events", async () => {
    const { client, requests } = await recordingClient();
    const messages: ChatMessage[] = [{ role: "user", content: "original request" }];
    const signal = new AbortController().signal;
    const first = await client.complete(messages, [{ name: "read_file" }], signal, undefined, undefined, { enableThinking: false });
    expect(first.usage).toEqual({ input: 120, output: 30, cached: 100, reasoning: 20 });
    messages.push({ role: "assistant", content: "done" }, { role: "tool", tool_call_id: "executed", content: "new result" });
    const next = await client.complete(messages, [{ name: "read_file" }], signal);
    expect(next.usage).toEqual({ input: 120, output: 30, cached: 100, reasoning: 20 });
    const [start, resumed] = await requests();
    expect(start!.args).toContain('model_reasoning_effort="medium"');
    expect(resumed!.args).toContain("resume");
    expect(resumed!.args[resumed!.args.indexOf("resume") + 1]).toMatch(/^[a-f0-9-]{36}$/);
    expect(resumed!.args.slice(0, 5)).toEqual(["exec", "--sandbox", "read-only", "-C", expect.any(String)]);
    expect(resumed!.input).toContain("new result");
    expect(resumed!.input).not.toContain("original request");
    expect(resumed!.input).not.toContain("Available luban tools");
  });

  it("resets after history or tools change and isolates auxiliary requests", async () => {
    const { client, requests } = await recordingClient();
    const signal = new AbortController().signal;
    const messages: ChatMessage[] = [{ role: "system", content: "rules" }, { role: "user", content: "task" }];
    await client.complete(messages, [], signal);
    await client.complete([{ role: "user", content: "summarize" }], [], signal);
    messages.push({ role: "assistant", content: "done" });
    await client.complete(messages, [], signal);
    messages[0]!.content = "updated rules";
    messages.push({ role: "user", content: "continue" });
    await client.complete(messages, [], signal);
    messages.push({ role: "assistant", content: "done" });
    await client.complete(messages, [{ name: "new_tool" }], signal);
    messages.splice(1, messages.length - 1, { role: "user", content: "compacted task" });
    await client.complete(messages, [{ name: "new_tool" }], signal);
    expect((await requests()).map(request => request.args.includes("resume"))).toEqual([false, false, true, false, false, false]);
  });

  it("invalidates a failed or timed out thread instead of reusing uncertain state", async () => {
    const { client, requests } = await recordingClient();
    const signal = new AbortController().signal;
    const messages: ChatMessage[] = [{ role: "user", content: "task" }];
    await client.complete(messages, [], signal);
    messages.push({ role: "tool", content: "FAIL_THIS_TURN" });
    await expect(client.complete(messages, [], signal)).rejects.toThrow("exit 7");
    messages.at(-1)!.content = "retry after failure";
    await client.complete(messages, [], signal);
    messages.push({ role: "tool", content: "WAIT_THIS_TURN" });
    await expect(client.complete(messages, [], signal, undefined, undefined, { timeoutMs: 200 })).rejects.toThrow("timed out");
    messages.at(-1)!.content = "retry after timeout";
    await client.complete(messages, [], signal);
    expect((await requests()).map(request => request.args.includes("resume"))).toEqual([false, true, false, true, false]);
  });
  it("does not time out an active CLI turn merely because total elapsed time exceeds the idle limit", async () => {
    const { client } = await recordingClient();
    await expect(client.complete([{ role: "user", content: "ACTIVE_THIS_TURN" }], [], new AbortController().signal,
      undefined, undefined, { timeoutMs: 500 })).resolves.toMatchObject({ content: "done" });
  });

  it("reaps a stalled CLI that ignores termination before returning its timeout", async () => {
    const { client, config } = await recordingClient();
    await expect(client.complete([{ role: "user", content: "IGNORE_TERM" }], [], new AbortController().signal,
      undefined, undefined, { timeoutMs: 500 })).rejects.toThrow("idle timeout");
    const pid = Number(await readFile(join(config.workspace, "child-pid"), "utf8"));
    expect(() => process.kill(pid, 0)).toThrow();
  }, 10_000);

  it("recovers a real CLI network exit through the agent without manual continue", async () => {
    const { client, config, requests } = await recordingClient();
    const runner = new AgentRunner(config, client);
    const notices: string[] = [];
    try {
      const result = await runner.run([...initialMessages(config.workspace), { role: "user", content: "NETWORK_ONCE" }],
        "agent", new AbortController().signal, event => { if (event.type === "status") notices.push(event.text); }, async () => "once");
      expect(result).toMatchObject({ ok: true, steps: 1, modelCalls: 2 });
      expect(await requests()).toHaveLength(2);
      expect(notices.join("")).toContain("自动重连");
    } finally { runner.close(); }
  });

  it("recovers missing output from a completed chunked event stream without replay", async () => {
    const { client, requests } = await recordingClient();
    const notices: string[] = [];
    const deltas: string[] = [];
    await expect(client.complete([{ role: 'user', content: 'OUTPUT_MODE:event' }], [], new AbortController().signal,
      text => deltas.push(text), text => notices.push(text))).resolves.toMatchObject({ content: 'done' });
    expect(await requests()).toHaveLength(1);
    expect(deltas).toEqual(['done']);
    expect(notices.join('')).toContain('事件流恢复');
  });

  it("automatically rebuilds a missing-output resumed turn with full authoritative history", async () => {
    const { client, requests } = await recordingClient();
    const messages: ChatMessage[] = [{ role: 'user', content: 'ORIGINAL_TASK' }];
    const signal = new AbortController().signal;
    await client.complete(messages, [], signal);
    messages.push({ role: 'tool', content: 'MISSING_ONCE already executed' });
    const notices: string[] = [];
    await expect(client.complete(messages, [], signal, undefined, text => notices.push(text))).resolves.toMatchObject({ content: 'done' });
    const recorded = await requests();
    expect(recorded.map(request => request.args.includes('resume'))).toEqual([false, true, false]);
    expect(recorded[2]!.input).toContain('ORIGINAL_TASK');
    expect(recorded[2]!.input).toContain('already executed');
    expect(notices.join('')).toContain('自动恢复');
  });

  it.each(['missing', 'partial', 'invalid-event', 'empty', 'invalid', 'malformed-call'])(
    "bounds retries for %s output and never emits incomplete answers", async mode => {
      const { client, requests } = await recordingClient();
      const deltas: string[] = [];
      await expect(client.complete([{ role: 'user', content: `OUTPUT_MODE:${mode}` }], [], new AbortController().signal,
        text => deltas.push(text))).rejects.toThrow('未生成有效结构化结果');
      expect(await requests()).toHaveLength(3);
      expect(deltas).toEqual([]);
    });

  it("honors disabled retries and does not replay explicit failures or cancellation", async () => {
    const { client, requests } = await recordingClient();
    await expect(client.complete([{ role: 'user', content: 'OUTPUT_MODE:missing' }], [], new AbortController().signal,
      undefined, undefined, { maxRetries: 0 })).rejects.toThrow('输出文件缺失');
    await expect(client.complete([{ role: 'user', content: 'OUTPUT_MODE:failed' }], [], new AbortController().signal)).rejects.toThrow('authentication required');
    const controller = new AbortController();
    await expect(client.complete([{ role: 'user', content: 'OUTPUT_MODE:missing' }], [], controller.signal,
      undefined, () => controller.abort(new Error('cancelled')))).rejects.toThrow('cancelled');
    expect(await requests()).toHaveLength(3);
  });

  it("uses CLI structured output and returns luban tool calls", async () => {
    const home = await mkdtemp(join(tmpdir(), "luban-codex-test-"));
    process.env.LUBAN_HOME = home;
    const fake = join(home, "codex");
    await writeFile(fake, `#!/usr/bin/env node
const fs = require('fs');
const args = process.argv.slice(2);
if (!args.includes('forced_login_method="chatgpt"')) process.exit(2);
if (args[args.indexOf('--model') + 1] !== 'gpt-6-sol') process.exit(4);
if (!args.includes('model_reasoning_effort="xhigh"')) process.exit(5);
const output = args[args.indexOf('--output-last-message') + 1];
let input = '';
process.stdin.on('data', chunk => input += chunk);
process.stdin.on('end', () => {
  if (!input.includes('Available luban tools')) process.exit(3);
  fs.writeFileSync(output, JSON.stringify({ content: '', tool_calls: [{ name: 'read_file', arguments: '{"path":"a.txt"}' }] }));
});
`, { mode: 0o755 });
    process.env.LUBAN_CODEX_BIN = fake;
    await savePreferredModel(home, "codex/gpt-6-sol", "xhigh");
    const config = loadConfig({ workspace: home, model: "codex/gpt-6-sol" });
    expect(config.model.api).toBe("codex");
    expect(config.model.reasoningEffort).toBe("xhigh");
    const result = await new CodexClient(config).complete([{ role: "user", content: "Read a.txt" }], [], new AbortController().signal);
    expect(result.toolCalls[0]?.function).toEqual({ name: "read_file", arguments: '{"path":"a.txt"}' });
  });

  it("passes malformed tool arguments to the runner for recoverable feedback", async () => {
    const home = await mkdtemp(join(tmpdir(), "luban-codex-test-"));
    process.env.LUBAN_HOME = home;
    const fake = join(home, "codex");
    await writeFile(fake, `#!/usr/bin/env node
const fs = require('fs');
const args = process.argv.slice(2);
const output = args[args.indexOf('--output-last-message') + 1];
const malformed = '{"path":"C:' + String.fromCharCode(92) + 'q"}';
fs.writeFileSync(output, JSON.stringify({ content: '', tool_calls: [{ name: 'read_file', arguments: malformed }] }));
`, { mode: 0o755 });
    process.env.LUBAN_CODEX_BIN = fake;
    const config = loadConfig({ workspace: home, model: "codex/gpt-6-sol" });
    const result = await new CodexClient(config).complete([{ role: "user", content: "Read a file" }], [], new AbortController().signal);
    expect(result.toolCalls[0]?.function.arguments).toBe('{"path":"C:\\q"}');
    expect(() => JSON.parse(result.toolCalls[0]!.function.arguments)).toThrow();
  });
});
