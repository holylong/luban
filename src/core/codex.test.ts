import { afterEach, describe, expect, it } from "vitest";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig, savePreferredModel } from "./config.js";
import { CodexClient } from "./codex.js";

const originalBin = process.env.LUBAN_CODEX_BIN;
const originalHome = process.env.LUBAN_HOME;
afterEach(() => {
  if (originalBin === undefined) delete process.env.LUBAN_CODEX_BIN;
  else process.env.LUBAN_CODEX_BIN = originalBin;
  if (originalHome === undefined) delete process.env.LUBAN_HOME;
  else process.env.LUBAN_HOME = originalHome;
});

describe("CodexClient", () => {
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
