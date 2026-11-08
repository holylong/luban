import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LubanRelayServer } from "./relay.js";

const NODE_TOKEN = "node-token";

describe("relay email verification", () => {
  let relay: LubanRelayServer;
  let relayUrl: string;
  let root: string;
  const sent: Array<{ to: string; code: string }> = [];

  const call = (path: string, init: RequestInit = {}): Promise<Response> =>
    fetch(`${relayUrl}${path}`, { ...init, headers: { ...init.headers }, redirect: "manual" });
  const sendCode = (email: string): Promise<Response> => call("/api/auth/send-code", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ email }),
  });
  const registerWith = (email: string, password: string, code?: string): Promise<Response> => call("/api/auth/register", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ email, password, ...(code === undefined ? {} : { code }) }),
  });
  const register = (email: string, code?: string): Promise<Response> => registerWith(email, "password-1", code);

  beforeEach(async () => {
    sent.length = 0;
    root = await mkdtemp(join(tmpdir(), "luban-relay-verification-"));
    relay = new LubanRelayServer({
      host: "127.0.0.1", port: 0, nodeToken: NODE_TOKEN,
      accountsPath: join(root, "accounts.json"),
      email: { sendVerificationCode: async (to, code) => { sent.push({ to, code }); } },
    });
    relayUrl = await relay.start();
  });

  afterEach(async () => {
    await relay.stop();
    await rm(root, { recursive: true, force: true });
  });

  it("advertises email verification and refuses registration without a code", async () => {
    const me = await call("/api/auth/me");
    expect(me.status).toBe(401);
    expect(await me.json()).toMatchObject({ email_verification: true });

    const missing = await register("owner@example.com");
    expect(missing.status).toBe(400);

    const sentResponse = await sendCode("owner@example.com");
    expect(sentResponse.status).toBe(200);
    expect(sent).toHaveLength(1);
    expect(sent[0]).toEqual({ to: "owner@example.com", code: expect.stringMatching(/^\d{6}$/u) });

    const created = await register("owner@example.com", sent[0]!.code);
    expect(created.status).toBe(200);
    expect(await created.json()).toMatchObject({ ok: true, account: { email: "owner@example.com" } });
  });

  it("rejects a wrong code and accepts the next correct one", async () => {
    await sendCode("owner@example.com");
    const wrong = sent[0]!.code === "000000" ? "111111" : "000000";
    expect((await register("owner@example.com", wrong)).status).toBe(400);
    expect((await register("owner@example.com", sent[0]!.code)).status).toBe(200);
  });

  it("does not burn the code when the password is too short", async () => {
    await sendCode("owner@example.com");
    expect((await registerWith("owner@example.com", "short", sent[0]!.code)).status).toBe(400);
    expect((await register("owner@example.com", sent[0]!.code)).status).toBe(200);
  });

  it("does not reveal or resend for an existing account", async () => {
    await sendCode("owner@example.com");
    expect((await register("owner@example.com", sent[0]!.code)).status).toBe(200);
    sent.length = 0;

    const again = await sendCode("owner@example.com");
    expect(again.status).toBe(200);
    expect(sent).toHaveLength(0);
  });

  it("throttles resends", async () => {
    expect((await sendCode("owner@example.com")).status).toBe(200);
    expect((await sendCode("owner@example.com")).status).toBe(429);
  });
});
