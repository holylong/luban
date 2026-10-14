import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

type JsonObject = Record<string, unknown>;

/**
 * OpenCode's Console session, read from wherever OpenCode keeps it — the same
 * "ask the tool that owns the login" arrangement luban uses for Codex, except
 * OpenCode has no queryable daemon command, so the credential files and the
 * sqlite store are read directly.
 *
 * Console OAuth is one supported credential source, alongside API keys and
 * anonymous free access. FreeTierError can instead mean the request's client,
 * session or tool payload is incompatible. Mirrors OpenCode's Console store.
 */
const DEFAULT_SERVER = "https://opencode.ai/console";
const CLIENT_ID = "opencode-cli";
const SERVICE = "opencode";
/** Treat a token that dies mid-run as already expired. */
const EXPIRY_SKEW_MS = 60_000;
const LOOKUP_TIMEOUT_MS = 10_000;
const REFRESH_TIMEOUT_MS = 20_000;

export interface ConsoleCredential {
  access: string;
  refresh: string;
  /** Epoch milliseconds; 0 when OpenCode stored no expiry. */
  expires: number;
  server: string;
}

function dataDir(): string {
  return process.env.XDG_DATA_HOME || join(homedir(), ".local", "share");
}

function lubanHome(): string {
  return process.env.LUBAN_HOME || join(homedir(), ".luban");
}

function readJson(path: string): JsonObject | undefined {
  try {
    if (!existsSync(path)) return undefined;
    const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as JsonObject) : undefined;
  } catch {
    return undefined;
  }
}

function text(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function credentialFrom(value: unknown): ConsoleCredential | undefined {
  const entry = (value && typeof value === "object" ? value : {}) as JsonObject;
  const metadata = (entry.metadata && typeof entry.metadata === "object" ? entry.metadata : {}) as JsonObject;
  const access = text(entry.access);
  // API keys are resolved separately in config.ts; this reader handles OAuth.
  if (!access || text(entry.key)) return undefined;
  return {
    access,
    refresh: text(entry.refresh),
    expires: typeof entry.expires === "number" && Number.isFinite(entry.expires) ? entry.expires : 0,
    server: text(metadata.server) || DEFAULT_SERVER,
  };
}

function fromAuthJson(data: JsonObject | undefined): ConsoleCredential | undefined {
  if (!data) return undefined;
  const direct = credentialFrom(data[SERVICE]);
  if (direct) return direct;
  const accounts = (data.accounts && typeof data.accounts === "object" ? data.accounts : {}) as JsonObject;
  for (const value of Object.values(accounts)) {
    const account = (value && typeof value === "object" ? value : {}) as JsonObject;
    const service = text(account.serviceID) || text(account.serviceId);
    if (service !== SERVICE) continue;
    const credential = credentialFrom(account.credential);
    if (credential) return credential;
  }
  return undefined;
}

/**
 * Recent OpenCode builds keep credentials in `opencode.db` and import `auth.json`
 * once. The read runs in a short-lived child so the experimental `node:sqlite`
 * warning never lands in the TUI and a multi-gigabyte database is not held open
 * by the long-lived process.
 */
function fromDatabase(): ConsoleCredential | undefined {
  const file = join(dataDir(), SERVICE, "opencode.db");
  if (!existsSync(file)) return undefined;
  const script = `
    const { DatabaseSync } = await import("node:sqlite");
    const db = new DatabaseSync(process.argv[1], { readOnly: true });
    const rows = db.prepare("SELECT value FROM credential WHERE integration_id = ? ORDER BY active DESC, time_created DESC, id DESC LIMIT 1").all(process.argv[2]);
    process.stdout.write(JSON.stringify(rows.map((row) => JSON.parse(row.value))));
  `;
  const result = spawnSync(process.execPath, ["--no-warnings", "--input-type=module", "-e", script, file, SERVICE], {
    encoding: "utf8",
    timeout: LOOKUP_TIMEOUT_MS,
  });
  if (result.status !== 0 || !result.stdout) return undefined;
  try {
    const parsed: unknown = JSON.parse(result.stdout);
    if (!Array.isArray(parsed)) return undefined;
    for (const value of parsed) {
      const credential = credentialFrom(value);
      if (credential) return credential;
    }
  } catch {
    // An unreadable store is not worth failing startup over.
  }
  return undefined;
}

function cachePath(): string {
  return join(lubanHome(), "opencode-console.json");
}

function readCache(): ConsoleCredential | undefined {
  const data = readJson(cachePath());
  if (!data) return undefined;
  const access = text(data.access);
  if (!access) return undefined;
  return {
    access,
    refresh: text(data.refresh),
    expires: typeof data.expires === "number" ? data.expires : 0,
    server: text(data.server) || DEFAULT_SERVER,
  };
}

function writeCache(credential: ConsoleCredential): void {
  try {
    mkdirSync(lubanHome(), { recursive: true });
    writeFileSync(cachePath(), JSON.stringify(credential), { mode: 0o600 });
  } catch {
    // The cache is an optimization; a read-only home just means refreshing again.
  }
}

function stored(): ConsoleCredential | undefined {
  const inline = process.env.OPENCODE_AUTH_CONTENT;
  if (inline) {
    try {
      const fromInline = fromAuthJson(JSON.parse(inline) as JsonObject);
      if (fromInline) return fromInline;
    } catch {
      // Malformed content falls through to the files.
    }
  }
  const base = join(dataDir(), SERVICE);
  for (const file of ["auth.json", "account.json"]) {
    const credential = fromAuthJson(readJson(join(base, file)));
    if (credential) return credential;
  }
  return fromDatabase();
}

function expired(credential: ConsoleCredential): boolean {
  return Boolean(credential.expires) && credential.expires - EXPIRY_SKEW_MS <= Date.now();
}

/** Trade the refresh token for a fresh access token; OpenCode's store is left alone. */
function refresh(credential: ConsoleCredential): ConsoleCredential | undefined {
  if (!credential.refresh) return undefined;
  const script = `
    const [server, token, clientID] = process.argv.slice(1);
    const response = await fetch(\`\${server.replace(/\\/$/, "")}/auth/device/token\`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ grant_type: "refresh_token", refresh_token: token, client_id: clientID }),
    });
    if (!response.ok) process.exit(1);
    process.stdout.write(JSON.stringify(await response.json()));
  `;
  const result = spawnSync(process.execPath, ["--no-warnings", "--input-type=module", "-e", script,
    credential.server, credential.refresh, CLIENT_ID], { encoding: "utf8", timeout: REFRESH_TIMEOUT_MS });
  if (result.status !== 0 || !result.stdout) return undefined;
  try {
    const token = JSON.parse(result.stdout) as JsonObject;
    const access = text(token.access_token);
    if (!access) return undefined;
    const next: ConsoleCredential = {
      access,
      refresh: text(token.refresh_token) || credential.refresh,
      expires: Date.now() + (typeof token.expires_in === "number" ? token.expires_in : 0) * 1000,
      server: credential.server,
    };
    writeCache(next);
    return next;
  } catch {
    return undefined;
  }
}

/**
 * A usable Console access token, or "" when OpenCode has never been logged in.
 * A cached token from an earlier run is preferred over OpenCode's own copy so a
 * rotated refresh does not leave luban holding a dead token.
 */
export function consoleAccessToken(): string {
  const candidates = [readCache(), stored()].filter((value): value is ConsoleCredential => Boolean(value));
  for (const candidate of candidates) {
    if (!expired(candidate)) return candidate.access;
    const renewed = refresh(candidate);
    if (renewed) return renewed.access;
  }
  return "";
}

/** Whether the free Zen models are worth offering, i.e. a Console session exists. */
export function consoleSessionAvailable(): boolean {
  return Boolean(consoleAccessToken());
}
