import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";

/**
 * Access control for the browser workspace.
 *
 * Two separate deployments need the same gate: `luban web --host 0.0.0.0`
 * (LAN) and the relay (public). Both expose an agent that can run shell
 * commands, so the token is the only thing between the internet and the
 * workspace.
 *
 * The token travels three ways because the browser refuses to send headers on
 * `EventSource`: the live event stream would otherwise be the one endpoint that
 * cannot authenticate. So `?token=` performs a one-time exchange for an
 * HttpOnly cookie, and the cookie is what the stream then uses.
 */
export const TOKEN_COOKIE = "luban_token";
export const TOKEN_HEADER = "x-luban-token";

/** 18 random bytes: 144 bits, short enough to type from a phone once. */
export function generateToken(bytes = 18): string {
  return randomBytes(bytes).toString("base64url");
}

/**
 * Constant-time comparison.
 *
 * Both sides are hashed first so `timingSafeEqual` cannot throw on a length
 * mismatch — the length itself would otherwise leak through the error path.
 */
export function tokenMatches(expected: string, candidate: string | undefined | null): boolean {
  if (!expected || !candidate) return false;
  const left = createHash("sha256").update(expected).digest();
  const right = createHash("sha256").update(candidate).digest();
  return timingSafeEqual(left, right);
}

export function parseCookie(header: string | undefined, name: string): string | undefined {
  if (!header) return undefined;
  for (const part of header.split(";")) {
    const index = part.indexOf("=");
    if (index < 0) continue;
    if (part.slice(0, index).trim() !== name) continue;
    return decodeURIComponent(part.slice(index + 1).trim());
  }
  return undefined;
}

export function tokenCookie(token: string, maxAgeSeconds = 60 * 60 * 24 * 30, secure = false): string {
  // SameSite=Lax keeps the workspace usable over plain HTTP on a LAN while
  // still blocking cross-site POSTs; there is no TLS guarantee on either path.
  return `${TOKEN_COOKIE}=${encodeURIComponent(token)}; Path=/; Max-Age=${maxAgeSeconds}; HttpOnly; SameSite=Lax${secure ? "; Secure" : ""}`;
}

export function clearCookie(name: string, secure = false): string {
  return `${name}=; Path=/; Max-Age=0; HttpOnly; SameSite=Lax${secure ? "; Secure" : ""}`;
}

export interface AuthDecision {
  ok: boolean;
  /** How the credential arrived, for logs and for deciding on a cookie exchange. */
  source?: "header" | "cookie" | "query";
  status?: 401 | 429;
  reason?: string;
  /** Set when the query string carried the token, i.e. it should become a cookie. */
  token?: string;
}

export interface AuthGateOptions {
  /** Failed attempts from one address before it is temporarily locked out. */
  maxFailures?: number;
  /** Length of the failure window and of the lockout, in milliseconds. */
  windowMs?: number;
  /** Injectable clock, so the lockout is testable without sleeping. */
  now?: () => number;
}

/**
 * Token gate with a per-address failure lockout.
 *
 * Without the lockout the token is still infeasible to guess, but every guess
 * costs a full agent request; the counter stops a scanner from turning the
 * relay into a load generator.
 */
export class AuthGate {
  private readonly failures = new Map<string, number[]>();
  private readonly maxFailures: number;
  private readonly windowMs: number;
  private readonly now: () => number;

  constructor(readonly token: string, options: AuthGateOptions = {}) {
    this.maxFailures = options.maxFailures ?? 20;
    this.windowMs = options.windowMs ?? 5 * 60_000;
    this.now = options.now ?? Date.now;
  }

  get enabled(): boolean {
    return Boolean(this.token);
  }

  private key(req: IncomingMessage): string {
    return req.socket.remoteAddress || "unknown";
  }

  private recent(req: IncomingMessage): number[] {
    const key = this.key(req);
    const cutoff = this.now() - this.windowMs;
    const kept = (this.failures.get(key) ?? []).filter(at => at > cutoff);
    if (kept.length) this.failures.set(key, kept);
    else this.failures.delete(key);
    return kept;
  }

  isLockedOut(req: IncomingMessage): boolean {
    return this.recent(req).length >= this.maxFailures;
  }

  /** Record a rejected attempt; returns true when this attempt trips the lockout. */
  recordFailure(req: IncomingMessage): boolean {
    const key = this.key(req);
    const kept = this.recent(req);
    kept.push(this.now());
    this.failures.set(key, kept);
    return kept.length >= this.maxFailures;
  }

  private recordSuccess(req: IncomingMessage): void {
    this.failures.delete(this.key(req));
  }

  /**
   * Verify one request. `url` is passed separately because the query string is
   * one of the three accepted carrier forms.
   */
  check(req: IncomingMessage, url: URL, additionalTokens: readonly string[] = []): AuthDecision {
    if (!this.enabled) return { ok: true };
    if (this.isLockedOut(req)) return { ok: false, status: 429, reason: "too many failed attempts; try again later" };
    const header = req.headers[TOKEN_HEADER];
    const bearer = /^Bearer\s+(.+)$/iu.exec(String(req.headers.authorization || ""));
    const candidates: Array<[AuthDecision["source"], string | undefined]> = [
      ["header", Array.isArray(header) ? header[0] : header],
      ["header", bearer?.[1]],
      ["query", url.searchParams.get("token") ?? undefined],
      ["cookie", parseCookie(req.headers.cookie, TOKEN_COOKIE)],
    ];
    for (const [source, candidate] of candidates) {
      if (candidate && [this.token, ...additionalTokens].some(expected => tokenMatches(expected, candidate))) {
        this.recordSuccess(req);
        return { ok: true, source, token: candidate };
      }
    }
    this.recordFailure(req);
    return { ok: false, status: 401, reason: "missing or invalid access token" };
  }
}

/**
 * Minimal token entry page.
 *
 * The phone usually arrives from a link that already carries `?token=`, so the
 * form is the fallback for a hand-typed link or an expired cookie.
 */
export function loginPage(options: { action?: string; error?: string; hint?: string } = {}): string {
  const escape = (value: string) => value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;");
  const action = options.action || "/login";
  return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
<meta name="color-scheme" content="dark"><title>luban · 访问令牌</title>
<style>
:root{color-scheme:dark}
body{margin:0;min-height:100dvh;display:grid;place-items:center;background:#05070a;color:#edf0f5;
font:16px/1.6 system-ui,-apple-system,"Segoe UI",sans-serif;padding:24px;padding-bottom:calc(24px + env(safe-area-inset-bottom))}
form{width:100%;max-width:380px;background:#101318;border:1px solid #252a34;border-radius:16px;padding:22px}
h1{margin:0 0 6px;font-size:19px}
p{margin:0 0 16px;color:#9299a8;font-size:13px}
input{width:100%;box-sizing:border-box;padding:14px;border:1px solid #2d333f;border-radius:11px;background:#0b0e13;color:inherit;font-size:16px}
button{width:100%;margin-top:12px;padding:14px;border:0;border-radius:11px;background:#edf0f5;color:#05070a;font-size:16px;font-weight:700}
.err{margin:0 0 12px;padding:10px 12px;border:1px solid #f2798b55;border-radius:10px;background:#2a1418;color:#f2798b;font-size:13px}
</style></head><body><form method="GET" action="${escape(action)}">
<h1>luban 控制台</h1><p>请输入访问令牌。令牌由启动命令输出，也可在 <code>--token</code> 中指定。</p>
${options.error ? `<div class="err">${escape(options.error)}</div>` : ""}
<input name="token" autocomplete="off" autocapitalize="off" spellcheck="false" placeholder="访问令牌" autofocus>
<button type="submit">进入</button>
${options.hint ? `<p style="margin:14px 0 0">${escape(options.hint)}</p>` : ""}
</form></body></html>`;
}

/** Answer a rejected request with JSON for APIs and the login page for pages. */
export function rejectAuth(res: ServerResponse, decision: AuthDecision, isApi: boolean): void {
  const status = decision.status ?? 401;
  if (isApi) {
    const body = JSON.stringify({ ok: false, error: decision.reason || "unauthorized", auth_required: true });
    res.writeHead(status, { "content-type": "application/json; charset=utf-8", "content-length": Buffer.byteLength(body), "www-authenticate": 'Bearer realm="luban"' });
    res.end(body);
    return;
  }
  const body = loginPage({ error: decision.reason });
  res.writeHead(status, { "content-type": "text/html; charset=utf-8", "content-length": Buffer.byteLength(body) });
  res.end(body);
}
