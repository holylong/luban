import { readFile, rename, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

/**
 * The ChatGPT login Codex CLI stores for itself. luban reads the same file so
 * one `codex login` serves both tools; a refreshed token is written back so
 * Codex CLI keeps working too.
 */
export interface CodexAuth {
  path: string;
  accessToken: string;
  accountId?: string;
  refreshToken?: string;
  clientId?: string;
  issuer: string;
  /** Access-token expiry in ms since epoch, when the JWT exposes one. */
  expiresAt?: number;
}

export const DEFAULT_CODEX_ISSUER = "https://auth.openai.com";
const REFRESH_SKEW_MS = 60_000;

function text(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

/** CODEX_HOME mirrors the Codex CLI; `~/.codex` is the default. */
export function codexHome(): string {
  return text(process.env.CODEX_HOME) ?? join(homedir(), ".codex");
}

export function codexAuthPath(home = codexHome()): string {
  return join(home, "auth.json");
}

function decodePayload(token: string): Record<string, unknown> {
  try {
    const part = token.split(".")[1] ?? "";
    return record(JSON.parse(Buffer.from(part, "base64url").toString("utf8")));
  } catch {
    return {};
  }
}

function expiresAt(token: string): number | undefined {
  const exp = decodePayload(token).exp;
  return typeof exp === "number" && Number.isFinite(exp) ? exp * 1000 : undefined;
}

function parseAuthFile(raw: unknown, path: string): CodexAuth | undefined {
  const tokens = record(record(raw).tokens);
  const accessToken = text(tokens.access_token);
  if (!accessToken) return undefined;
  const provenance = record(tokens.oauth_provenance);
  const accountId = text(tokens.account_id)
    ?? text(record(decodePayload(accessToken)["https://api.openai.com/auth"]).chatgpt_account_id)
    ?? text(record(decodePayload(text(tokens.id_token) ?? "")["https://api.openai.com/auth"]).chatgpt_account_id);
  const parsed: CodexAuth = {
    path,
    accessToken,
    ...(accountId ? { accountId } : {}),
    ...(text(tokens.refresh_token) ? { refreshToken: text(tokens.refresh_token) } : {}),
    ...(text(provenance.client_id) ? { clientId: text(provenance.client_id) } : {}),
    issuer: text(provenance.issuer) ?? DEFAULT_CODEX_ISSUER,
    ...(expiresAt(accessToken) ? { expiresAt: expiresAt(accessToken) } : {}),
  };
  return parsed;
}

/** The ChatGPT login behind Codex CLI, or undefined when only an API key is configured. */
export async function readCodexAuth(home = codexHome()): Promise<CodexAuth | undefined> {
  const path = codexAuthPath(home);
  try {
    return parseAuthFile(JSON.parse(await readFile(path, "utf8")), path);
  } catch {
    return undefined;
  }
}

export function codexAuthExpired(auth: CodexAuth, now = Date.now()): boolean {
  return auth.expiresAt !== undefined && auth.expiresAt - REFRESH_SKEW_MS <= now;
}

/**
 * Exchange the stored refresh token for a fresh access token and write the
 * result back so the Codex CLI stays logged in. Returns undefined when the
 * login cannot be refreshed (missing refresh token, revoked, offline).
 */
export async function refreshCodexAuth(auth: CodexAuth, fetchImpl: typeof fetch = fetch, now = Date.now()): Promise<CodexAuth | undefined> {
  if (!auth.refreshToken) return undefined;
  try {
    const response = await fetchImpl(`${auth.issuer.replace(/\/$/, "")}/oauth/token`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json" },
      body: new URLSearchParams({
        grant_type: "refresh_token",
        refresh_token: auth.refreshToken,
        ...(auth.clientId ? { client_id: auth.clientId } : {}),
        scope: "openid profile email",
      }).toString(),
    });
    if (!response.ok) return undefined;
    const data = record(await response.json());
    const accessToken = text(data.access_token);
    if (!accessToken) return undefined;
    const next: CodexAuth = {
      ...auth,
      accessToken,
      ...(text(data.refresh_token) ? { refreshToken: text(data.refresh_token) } : {}),
      expiresAt: expiresAt(accessToken) ?? (typeof data.expires_in === "number" ? now + data.expires_in * 1000 : undefined),
    };
    await persist(auth.path, next, text(data.id_token), now);
    return next;
  } catch {
    return undefined;
  }
}

async function persist(path: string, auth: CodexAuth, idToken: string | undefined, now: number): Promise<void> {
  try {
    const raw = record(JSON.parse(await readFile(path, "utf8")));
    const tokens = {
      ...record(raw.tokens),
      access_token: auth.accessToken,
      ...(auth.refreshToken ? { refresh_token: auth.refreshToken } : {}),
      ...(idToken ? { id_token: idToken } : {}),
    };
    const next = { ...raw, tokens, last_refresh: new Date(now).toISOString() };
    const temporary = `${path}.luban-${process.pid}.tmp`;
    await writeFile(temporary, JSON.stringify(next, null, 2), { mode: 0o600 });
    await rename(temporary, path);
  } catch {
    // A read-only home only costs the next process a refresh; the turn continues.
  }
}
