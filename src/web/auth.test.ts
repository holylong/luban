import { describe, expect, it } from "vitest";
import type { IncomingMessage } from "node:http";
import { AuthGate, generateToken, loginPage, parseCookie, tokenCookie, tokenMatches } from "./auth.js";

/** Minimal request stand-in: only the fields the gate reads. */
function request(headers: Record<string, string> = {}, address = "10.0.0.1"): IncomingMessage {
  return { headers, socket: { remoteAddress: address } } as unknown as IncomingMessage;
}

const url = (search = ""): URL => new URL(`/api/node${search}`, "http://luban.local");

describe("token comparison", () => {
  it("accepts only an exact match", () => {
    const token = generateToken();
    expect(tokenMatches(token, token)).toBe(true);
    expect(tokenMatches(token, `${token}x`)).toBe(false);
    expect(tokenMatches(token, token.slice(0, -1))).toBe(false);
    expect(tokenMatches(token, "")).toBe(false);
    expect(tokenMatches(token, undefined)).toBe(false);
  });

  it("never throws on a length mismatch", () => {
    expect(tokenMatches("short", "a-much-longer-token")).toBe(false);
  });
});

describe("cookies", () => {
  it("reads one cookie out of many", () => {
    expect(parseCookie("a=1; luban_token=secret; b=2", "luban_token")).toBe("secret");
    expect(parseCookie(undefined, "luban_token")).toBeUndefined();
    expect(parseCookie("other=1", "luban_token")).toBeUndefined();
  });

  it("round-trips a token through the Set-Cookie value", () => {
    const token = generateToken();
    const header = tokenCookie(token);
    const cookiePair = header.slice(0, header.indexOf(";"));
    expect(parseCookie(cookiePair, "luban_token")).toBe(token);
    expect(header).toContain("HttpOnly");
    expect(header).toContain("SameSite=Lax");
    expect(tokenCookie(token, undefined, true)).toContain("; Secure");
  });
});

describe("auth gate", () => {
  it("is disabled without a token", () => {
    const gate = new AuthGate("");
    expect(gate.enabled).toBe(false);
    expect(gate.check(request(), url()).ok).toBe(true);
  });

  it("accepts the token from header, query and cookie", () => {
    const gate = new AuthGate("s3cret");
    expect(gate.check(request({ "x-luban-token": "s3cret" }), url()).source).toBe("header");
    expect(gate.check(request({ authorization: "Bearer s3cret" }), url()).source).toBe("header");
    expect(gate.check(request(), url("?token=s3cret")).source).toBe("query");
    expect(gate.check(request({ cookie: "luban_token=s3cret" }), url()).source).toBe("cookie");
  });

  it("reports how a query token arrived so it can be exchanged for a cookie", () => {
    const gate = new AuthGate("s3cret");
    const decision = gate.check(request(), url("?token=s3cret"));
    expect(decision.ok).toBe(true);
    expect(decision.token).toBe("s3cret");
  });

  it("rejects a wrong or missing token", () => {
    const gate = new AuthGate("s3cret");
    const decision = gate.check(request({ "x-luban-token": "nope" }), url());
    expect(decision.ok).toBe(false);
    expect(decision.status).toBe(401);
  });

  it("locks out an address after repeated failures and frees it after the window", () => {
    let now = 1_000_000;
    const gate = new AuthGate("s3cret", { maxFailures: 3, windowMs: 1000, now: () => now });
    const attacker = request({ "x-luban-token": "nope" }, "9.9.9.9");
    expect(gate.check(attacker, url()).status).toBe(401);
    expect(gate.check(attacker, url()).status).toBe(401);
    gate.check(attacker, url());
    expect(gate.check(attacker, url()).status).toBe(429);
    // A different address is unaffected: the lockout is per client.
    expect(gate.check(request({ "x-luban-token": "nope" }, "8.8.8.8"), url()).status).toBe(401);
    now += 2000;
    expect(gate.check(attacker, url()).status).toBe(401);
  });

  it("forgets failures once the token is right", () => {
    const gate = new AuthGate("s3cret", { maxFailures: 2 });
    const client = request({ "x-luban-token": "nope" });
    gate.check(client, url());
    expect(gate.check(request({ "x-luban-token": "s3cret" }), url()).ok).toBe(true);
    expect(gate.isLockedOut(request())).toBe(false);
  });
});

describe("login page", () => {
  it("escapes anything interpolated into the form", () => {
    const page = loginPage({ error: "<script>alert(1)</script>", action: '/login" onload="x' });
    expect(page).not.toContain("<script>alert(1)</script>");
    expect(page).toContain("&lt;script&gt;");
    expect(page).not.toContain('onload="x"');
  });
});
