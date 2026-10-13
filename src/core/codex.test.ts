import { afterEach, describe, expect, it } from "vitest";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig, savePreferredModel } from "./config.js";
import { CodexClient } from "./codex.js";
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
  fs.appendFileSync(${JSON.stringify(log)}, JSON.stringify({args, input}) + '\\n');
  if (!args.includes('--json') || args.includes('--ephemeral')) process.exit(9);
  if (input.includes('FAIL_THIS_TURN')) process.exit(7);
  if (input.includes('WAIT_THIS_TURN')) return setInterval(() => {}, 1000);
  const id = args.includes('resume') ? args[args.indexOf('resume') + 1] : require('crypto').randomUUID();
  const started = JSON.stringify({type: 'thread.started', thread_id: id}) + '\\n';
  process.stdout.write(started.slice(0, 11));
  process.stdout.write(started.slice(11));
  const output = args[args.indexOf('--output-last-message') + 1];
  fs.writeFileSync(output, JSON.stringify({content:'done', tool_calls:[]}));
  process.stdout.write(JSON.stringify({type:'turn.completed', usage:{input_tokens:120, cached_input_tokens:100, output_tokens:30, reasoning_output_tokens:20}}));
});
`, { mode: 0o755 });
  process.env.LUBAN_CODEX_BIN = fake;
  await savePreferredModel(home, "codex/gpt-6.1-sol", "medium");
  const config = loadConfig({ workspace: home, model: "codex/gpt-6.1-sol" });
  const requests = async () => (await readFile(log, "utf8")).trim().split("\n")
    .map(line => JSON.parse(line) as { args: string[]; input: string });
  return { client: new CodexClient(config), requests };
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
  it("resumes the exact thread, sends only appended messages, and parses chunked usage events", async () => {
    const { client, requests } = await recordingClient();
    const messages: ChatMessage[] = [{ role: "user", content: "original request" }];
    const signal = new AbortController().signal;
    const first = await client.complete(messages, [{ name: "read_file" }], signal, undefined, undefined, { enableThinking: false });
    expect(first.usage).toEqual({ input: 120, output: 30, cached: 100, reasoning: 20 });
    messages.push({ role: "assistant", content: "done" }, { role: "tool", tool_call_id: "executed", content: "new result" });
    await client.complete(messages, [{ name: "read_file" }], signal);
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
