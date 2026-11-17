import { afterEach, describe, expect, it, vi } from "vitest";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { interactionCompletion, interactionFetch } from "./interaction-log.js";
import type { LubanConfig } from "./types.js";

const homes: string[] = [];
function setup(enabled = true, key = "secret-key"): LubanConfig {
  const home = mkdtempSync(join(tmpdir(), "luban-interactions-")); homes.push(home);
  return { home, interactionLog: { enabled }, model: { apiKey: key, model: "test-model", provider: "test" } } as LubanConfig;
}
function rows(config: LubanConfig): Array<Record<string, any>> {
  const dir = join(config.home, "logs", "interactions");
  return readFileSync(join(dir, readdirSync(dir)[0]!), "utf8").trim().split("\n").map(line => JSON.parse(line));
}
function bytes(entries: Array<Record<string, any>>, event: string): string {
  return Buffer.concat(entries.filter(row => row.event === event).map(row => Buffer.from(row.body, "base64"))).toString();
}
afterEach(() => { vi.unstubAllGlobals(); for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true }); });
describe("logical interactions", () => {
  it("captures replies and usage, redacts credentials, and omits exception messages", async () => {
    const config = setup();
    const result = { content: "token-value", reasoning: "", toolCalls: [], usage: { input: 3, output: 2 } };
    expect(await interactionCompletion(config, "codex-backend", 0, { messages: ["secret-key"] }, async () => result, ["token-value"])).toBe(result);
    const entries = rows(config);
    expect(entries.map(row => row.event)).toEqual(["request", "reply", "end"]);
    expect(bytes(entries, "request")).toContain("[REDACTED]");
    expect(JSON.parse(bytes(entries, "reply"))).toMatchObject({ content: "[REDACTED]", usage: result.usage });
    await expect(interactionCompletion(config, "codex-cli", 1, {}, async () => { throw new Error("do-not-log"); })).rejects.toThrow("do-not-log");
    expect(JSON.stringify(rows(config))).not.toContain("do-not-log");
    expect(rows(config).at(-1)!.event).toBe("completion_error");
  });
});

describe("interactionFetch", () => {
  it("is default-off and leaves the response untouched", async () => {
    const config = setup(false); delete config.interactionLog;
    const response = new Response("ok"); vi.stubGlobal("fetch", vi.fn().mockResolvedValue(response));
    expect(await interactionFetch(config, 0, "https://test", {})).toBe(response);
    expect(existsSync(join(config.home, "logs"))).toBe(false);
  });
  it("captures exact JSON and streamed bytes without pre-reading and redacts keys across chunks", async () => {
    const config = setup(); let pulls = 0;
    const chunks = ['data: secret-', 'key secret-key ', '你好\nusage: {"input_tokens":3}\n'];
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(new ReadableStream({ pull(c) { pulls++; const text = chunks.shift(); if (text === undefined) c.close(); else c.enqueue(Buffer.from(text)); } }, { highWaterMark: 0 }), { headers: { authorization: "do-not-log" } })));
    const original = '{ "model": "test", "text": "secret-key" }';
    const response = await interactionFetch(config, 2, "https://secret-url", { body: original, headers: { authorization: "do-not-log" } });
    expect(pulls).toBe(0);
    expect(await response.text()).toBe('data: secret-key secret-key 你好\nusage: {"input_tokens":3}\n');
    const entries = rows(config);
    expect(bytes(entries, "request")).toBe(original.replace("secret-key", "[REDACTED]"));
    expect(bytes(entries, "response_bytes")).toBe('data: [REDACTED] [REDACTED] 你好\nusage: {"input_tokens":3}\n');
    expect(JSON.stringify(entries)).not.toMatch(/do-not-log|secret-url|secret-key/);
    expect(entries.every(row => row.attempt === 2 && row.timestamp && row.requestId === entries[0]!.requestId)).toBe(true);
    if (process.platform !== "win32") {
      const dir = join(config.home, "logs", "interactions");
      expect(statSync(dir).mode & 0o777).toBe(0o700);
      expect(statSync(join(dir, readdirSync(dir)[0]!)).mode & 0o777).toBe(0o600);
    }
  });
  it("records nonstream HTTP errors and transport failures as distinct attempts", async () => {
    const config = setup(); vi.stubGlobal("fetch", vi.fn().mockResolvedValueOnce(new Response('{"error":"busy"}', { status: 503 })).mockRejectedValueOnce(new Error("secret-key")));
    expect(await (await interactionFetch(config, 0, "https://test", {})).text()).toBe('{"error":"busy"}');
    await expect(interactionFetch(config, 1, "https://test", {})).rejects.toThrow("secret-key");
    const entries = rows(config);
    expect(entries.some(row => row.status === 503)).toBe(true);
    expect(entries.at(-1)!.event).toBe("transport_error");
    expect(new Set(entries.map(row => row.requestId)).size).toBe(2);
  });
  it("preserves stream failures and cancellation", async () => {
    const config = setup(); vi.stubGlobal("fetch", vi.fn().mockImplementation(() => Promise.resolve(new Response(new ReadableStream({ pull(c) { c.error(new Error("broken")); } }, { highWaterMark: 0 })))));
    await expect((await interactionFetch(config, 0, "https://test", {})).text()).rejects.toThrow("broken");
    await (await interactionFetch(config, 1, "https://test", {})).body!.cancel();
    expect(rows(config).map(row => row.event)).toContain("stream_error");
    expect(rows(config).at(-1)!.event).toBe("cancel");
  });
  it("does not fail requests when the log directory is unwritable", async () => {
    const config = setup(); writeFileSync(join(config.home, "logs"), "not a directory");
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("ok")));
    expect(await (await interactionFetch(config, 0, "https://test", {})).text()).toBe("ok");
  });
});
