import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { CODEX_BACKEND_BASE, CodexBackendClient, codexTransport, type CompletionClient } from "./codex-backend.js";
import { readCodexAuth, refreshCodexAuth, type CodexAuth } from "./codex-auth.js";
import type { LubanConfig } from "./types.js";

function config(overrides: Partial<LubanConfig["model"]> = {}): LubanConfig {
  return {
    model: {
      id: "codex/gpt-6-luna", provider: "codex", model: "gpt-6-luna", name: "gpt-6-luna", baseUrl: "https://chatgpt.com/backend-api/codex",
      apiKey: "", api: "codex", capabilities: { vision: true, thinking: true, tools: true, responses: true }, ...overrides,
    },
    maxTokens: 1000, temperature: 0.2, timeoutMs: 5000, maxRetries: 0,
  } as LubanConfig;
}

const auth: CodexAuth = {
  path: "/tmp/auth.json", accessToken: "token-old", accountId: "acct-1",
  refreshToken: "refresh-1", clientId: "app_1", issuer: "https://auth.openai.com",
};

function sse(events: unknown[]): Response {
  const body = new ReadableStream({
    start(controller) {
      const encoder = new TextEncoder();
      for (const event of events) controller.enqueue(encoder.encode(`data: ${JSON.stringify(event)}\n\n`));
      controller.close();
    },
  });
  return new Response(body, { headers: { "content-type": "text/event-stream" } });
}

/** The ChatGPT backend streams SSE with no content-type header at all. */
function sseNoType(events: unknown[]): Response {
  const body = new ReadableStream({
    start(controller) {
      const encoder = new TextEncoder();
      for (const event of events) {
        controller.enqueue(encoder.encode(`event: ${String((event as { type?: string }).type ?? "message")}\ndata: ${JSON.stringify(event)}\n\n`));
      }
      controller.close();
    },
  });
  return new Response(body);
}

function completed(output: unknown[]) {
  return [
    { type: "response.created", response: { id: "r1" } },
    ...output,
    { type: "response.completed", response: { id: "r1", status: "completed", output, usage: { input_tokens: 40, output_tokens: 6 } } },
  ];
}

function fakeCli(): CompletionClient & { calls: number } {
  const client = {
    calls: 0,
    async complete() {
      client.calls += 1;
      return { content: "from-cli", reasoning: "", toolCalls: [], usage: { input: 14_712, output: 5 } };
    },
  };
  return client as CompletionClient & { calls: number };
}

async function withFetch<T>(impl: typeof fetch, run: () => Promise<T>): Promise<T> {
  const original = globalThis.fetch;
  globalThis.fetch = impl;
  try { return await run(); } finally { globalThis.fetch = original; }
}

describe("codex backend transport", () => {
  it("logs one logical backend request/reply with usage, without HTTP duplication or credentials", async () => {
    const home = await mkdtemp(join(tmpdir(), "luban-backend-log-"));
    const cfg = { ...config(), home, interactionLog: { enabled: true } };
    try {
      const client = new CodexBackendClient(cfg, { mode: "native", loadAuth: async () => auth });
      await withFetch((async () => sse(completed([{ type: "message", role: "assistant", content: [{ type: "output_text", text: "done" }] }]))) as typeof fetch, async () => {
        await client.complete([{ role: "user", content: "hello" }], [], new AbortController().signal);
      });
      const directory = join(home, "logs", "interactions");
      const text = await readFile(join(directory, (await readdir(directory))[0]!), "utf8");
      const entries = text.trim().split("\n").map(line => JSON.parse(line));
      expect(entries.map(row => row.event)).toEqual(["request", "reply", "end"]);
      expect(JSON.parse(Buffer.from(entries[1].body, "base64").toString()).usage).toMatchObject({ input: 40, output: 6 });
      expect(text).not.toMatch(/token-old|refresh-1|acct-1|authorization/);
    } finally { await rm(home, { recursive: true, force: true }); }
  });
  it("defaults to native, maps legacy auto to native and requires explicit cli", () => {
    const saved = process.env.LUBAN_CODEX_MODE;
    try {
      delete process.env.LUBAN_CODEX_MODE;
      expect(codexTransport()).toBe("native");
      expect(codexTransport("auto")).toBe("native");
      expect(codexTransport("unknown")).toBe("native");
      process.env.LUBAN_CODEX_MODE = "auto";
      expect(codexTransport()).toBe("native");
      expect(codexTransport("cli")).toBe("cli");
      expect(codexTransport(" NATIVE ")).toBe("native");
      process.env.LUBAN_CODEX_MODE = "cli";
      expect(codexTransport()).toBe("cli");
    } finally {
      if (saved === undefined) delete process.env.LUBAN_CODEX_MODE;
      else process.env.LUBAN_CODEX_MODE = saved;
    }
  });

  it("requests chatgpt.com/backend-api/codex/responses with luban's own tools", async () => {
    const client = new CodexBackendClient(config({ reasoningEffort: "high" }), { loadAuth: async () => auth, fallback: fakeCli() });
    let seen: { url: string; headers: Headers; body: Record<string, unknown> } | undefined;
    await withFetch((async (url: string, init: RequestInit) => {
      seen = { url: String(url), headers: new Headers(init.headers), body: JSON.parse(String(init.body)) as Record<string, unknown> };
      return sse(completed([
        { type: "message", role: "assistant", content: [{ type: "output_text", text: "done" }] },
        { type: "function_call", id: "fc1", call_id: "call_1", name: "read_file", arguments: "{\"path\":\"a.ts\"}" },
      ]));
    }) as unknown as typeof fetch, async () => {
      const result = await client.complete([{ role: "system", content: "sys" }, { role: "user", content: "hi" }],
        [{ type: "function", function: { name: "read_file", description: "read", parameters: { type: "object" } } }],
        new AbortController().signal);
      expect(result.content).toBe("done");
      expect(result.toolCalls[0]).toMatchObject({ id: "call_1", function: { name: "read_file", arguments: "{\"path\":\"a.ts\"}" } });
      expect(result.usage).toMatchObject({ input: 40, output: 6 });
    });
    expect(seen?.url).toBe(`${CODEX_BACKEND_BASE}/responses`);
    expect(seen?.headers.get("authorization")).toBe("Bearer token-old");
    expect(seen?.headers.get("chatgpt-account-id")).toBe("acct-1");
    expect(seen?.headers.get("originator")).toBe("codex_cli_rs");
    expect(seen?.headers.get("openai-beta")).toBe("responses=experimental");
    expect(seen?.headers.get("session_id")).toBeTruthy();
    expect(seen?.body).toMatchObject({ model: "gpt-6-luna", store: false, stream: true, instructions: "sys", reasoning: { effort: "high" } });
    // The backend rejects an explicit temperature.
    expect(seen?.body).not.toHaveProperty("temperature");
    expect(seen?.body.tools).toEqual([{ type: "function", name: "read_file", description: "read", parameters: { type: "object" } }]);
  });

  it("parses the headerless SSE the ChatGPT backend actually sends", async () => {
    const cli = fakeCli();
    const client = new CodexBackendClient(config(), { loadAuth: async () => auth, fallback: cli });
    await withFetch((async () => sseNoType(completed([
      { type: "message", role: "assistant", content: [{ type: "output_text", text: "headerless" }] },
    ]))) as unknown as typeof fetch, async () => {
      const result = await client.complete([{ role: "user", content: "hi" }], [], new AbortController().signal);
      expect(result.content).toBe("headerless");
    });
    expect(cli.calls).toBe(0);
  });

  it("streams assistant text as deltas", async () => {
    const client = new CodexBackendClient(config(), { loadAuth: async () => auth, fallback: fakeCli() });
    const deltas: string[] = [];
    await withFetch((async () => sse(completed([
      { type: "response.output_text.delta", delta: "he" },
      { type: "response.output_text.delta", delta: "llo" },
      { type: "message", role: "assistant", content: [{ type: "output_text", text: "hello" }] },
    ]))) as unknown as typeof fetch, async () => {
      const result = await client.complete([{ role: "user", content: "hi" }], [], new AbortController().signal,
        (text) => deltas.push(text));
      expect(result.content).toBe("hello");
    });
    expect(deltas).toEqual(["he", "llo"]);
  });

  it("refreshes the ChatGPT login once on 401", async () => {
    let attempts = 0;
    const tokens: string[] = [];
    const refreshed: CodexAuth = { ...auth, accessToken: "token-new" };
    let refreshes = 0;
    const client = new CodexBackendClient(config(), {
      loadAuth: async () => auth,
      refresh: async () => { refreshes += 1; return refreshed; },
      fallback: fakeCli(),
    });
    await withFetch((async (_url: string, init: RequestInit) => {
      attempts += 1;
      tokens.push(new Headers(init.headers).get("authorization") ?? "");
      if (attempts === 1) return new Response("{\"detail\":\"unauthorized\"}", { status: 401 });
      return sse(completed([{ type: "message", role: "assistant", content: [{ type: "output_text", text: "after-refresh" }] }]));
    }) as unknown as typeof fetch, async () => {
      const result = await client.complete([{ role: "user", content: "hi" }], [], new AbortController().signal);
      expect(result.content).toBe("after-refresh");
    });
    expect(refreshes).toBe(1);
    expect(tokens).toEqual(["Bearer token-old", "Bearer token-new"]);
  });

  it.each([undefined, "auto", "native"])("never uses CLI for backend errors in mode %s", async (mode) => {
    const cli = fakeCli();
    const notices: string[] = [];
    const client = new CodexBackendClient(config(), { loadAuth: async () => auth, fallback: cli, mode });
    await withFetch((async () => new Response("{\"detail\":\"boom\"}", { status: 502 })) as unknown as typeof fetch, async () => {
      await expect(client.complete([{ role: "user", content: "hi" }], [], new AbortController().signal, undefined,
        (text) => notices.push(text))).rejects.toThrow(/model HTTP 502/u);
    });
    expect(cli.calls).toBe(0);
    expect(notices.join("\n")).not.toContain("改用官方 codex CLI");
  });

  it("reports a missing ChatGPT login without using CLI", async () => {
    const cli = fakeCli();
    const client = new CodexBackendClient(config(), { loadAuth: async () => undefined, fallback: cli });
    await expect(client.complete([{ role: "user", content: "hi" }], [], new AbortController().signal))
      .rejects.toThrow(/codex login/u);
    expect(cli.calls).toBe(0);
  });

  it("reports failed login refresh without using CLI", async () => {
    const cli = fakeCli();
    const client = new CodexBackendClient(config(), {
      loadAuth: async () => auth, refresh: async () => undefined, fallback: cli,
    });
    await withFetch((async () => new Response("unauthorized", { status: 401 })) as unknown as typeof fetch, async () => {
      await expect(client.complete([{ role: "user", content: "hi" }], [], new AbortController().signal))
        .rejects.toThrow(/model HTTP 401/u);
    });
    expect(cli.calls).toBe(0);
  });

  it("propagates network failures without using CLI", async () => {
    const cli = fakeCli();
    const client = new CodexBackendClient(config(), { loadAuth: async () => auth, fallback: cli });
    await withFetch((async () => { throw new TypeError("fetch failed"); }) as typeof fetch, async () => {
      await expect(client.complete([{ role: "user", content: "hi" }], [], new AbortController().signal))
        .rejects.toThrow(/fetch failed/u);
    });
    expect(cli.calls).toBe(0);
  });

  it("fails loudly in forced native mode instead of silently using the CLI", async () => {
    const cli = fakeCli();
    const client = new CodexBackendClient(config(), { loadAuth: async () => undefined, fallback: cli, mode: "native" });
    await expect(client.complete([{ role: "user", content: "hi" }], [], new AbortController().signal))
      .rejects.toThrow(/codex login/u);
    expect(cli.calls).toBe(0);
  });

  it("never falls back after output already streamed", async () => {
    const cli = fakeCli();
    const client = new CodexBackendClient(config(), { loadAuth: async () => auth, fallback: cli });
    await withFetch((async () => sse([
      { type: "response.output_text.delta", delta: "partial" },
      { type: "response.failed", response: { status: "failed", error: { message: "upstream" } } },
    ])) as unknown as typeof fetch, async () => {
      await expect(client.complete([{ role: "user", content: "hi" }], [], new AbortController().signal, () => {}))
        .rejects.toThrow(/model stream error/u);
    });
    expect(cli.calls).toBe(0);
  });

  it("uses the CLI directly when the transport is forced to cli", async () => {
    const cli = fakeCli();
    const client = new CodexBackendClient(config(), { loadAuth: async () => auth, fallback: cli, mode: "cli" });
    const result = await client.complete([{ role: "user", content: "hi" }], [], new AbortController().signal);
    expect(result.content).toBe("from-cli");
    expect(cli.calls).toBe(1);
  });
});

describe("codex auth file", () => {
  const fixture = (overrides: Record<string, unknown> = {}) => ({
    auth_mode: "chatgpt",
    OPENAI_API_KEY: null,
    tokens: {
      access_token: "jwt-access", refresh_token: "refresh-1", id_token: "jwt-id",
      account_id: "acct-1", oauth_provenance: { issuer: "https://auth.openai.com", client_id: "app_1" },
      ...overrides,
    },
    last_refresh: "2026-10-01T00:00:00Z",
  });

  it("reads the ChatGPT login and its account id", async () => {
    const home = await mkdtemp(join(tmpdir(), "luban-codex-auth-"));
    try {
      await writeFile(join(home, "auth.json"), JSON.stringify(fixture()));
      const parsed = await readCodexAuth(home);
      expect(parsed).toMatchObject({ accessToken: "jwt-access", accountId: "acct-1", refreshToken: "refresh-1", clientId: "app_1", issuer: "https://auth.openai.com" });
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });

  it("ignores an API-key-only login", async () => {
    const home = await mkdtemp(join(tmpdir(), "luban-codex-auth-"));
    try {
      await writeFile(join(home, "auth.json"), JSON.stringify({ auth_mode: "apikey", OPENAI_API_KEY: "sk-x", tokens: null }));
      expect(await readCodexAuth(home)).toBeUndefined();
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });

  it("refreshes and writes the rotated tokens back for the Codex CLI", async () => {
    const home = await mkdtemp(join(tmpdir(), "luban-codex-auth-"));
    try {
      const path = join(home, "auth.json");
      await writeFile(path, JSON.stringify(fixture()));
      const parsed = (await readCodexAuth(home))!;
      let requested = "";
      const next = await refreshCodexAuth(parsed, (async (url: string, init: RequestInit) => {
        requested = `${url} ${String(init.body)}`;
        return new Response(JSON.stringify({ access_token: "jwt-access-2", refresh_token: "refresh-2", id_token: "jwt-id-2", expires_in: 3600 }), { headers: { "content-type": "application/json" } });
      }) as unknown as typeof fetch, Date.parse("2026-10-30T00:00:00Z"));
      expect(requested).toContain("https://auth.openai.com/oauth/token");
      expect(requested).toContain("grant_type=refresh_token");
      expect(requested).toContain("client_id=app_1");
      expect(next).toMatchObject({ accessToken: "jwt-access-2", refreshToken: "refresh-2", accountId: "acct-1" });
      const reread = await readCodexAuth(home);
      expect(reread).toMatchObject({ accessToken: "jwt-access-2", refreshToken: "refresh-2" });
      expect(JSON.parse(await (await import("node:fs/promises")).readFile(path, "utf8")).last_refresh).toBe("2026-10-30T00:00:00.000Z");
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });

  it("returns undefined when the refresh token is rejected", async () => {
    const parsed: CodexAuth = { path: "/tmp/none.json", accessToken: "a", refreshToken: "r", issuer: "https://auth.openai.com" };
    const next = await refreshCodexAuth(parsed, (async () => new Response("{}", { status: 400 })) as unknown as typeof fetch);
    expect(next).toBeUndefined();
  });
});
