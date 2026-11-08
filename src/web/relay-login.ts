import { chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { normalizeRelayUrl } from "./tunnel.js";

const LOOPBACK = new Set(["127.0.0.1", "localhost", "::1", "[::1]"]);

export interface RelayEnrollment {
  /** Normalized relay address the token belongs to. */
  relayUrl: string;
  /** Account email when the enrollment came from a password login. */
  email: string;
  /** Environment key that holds the device token at runtime. */
  envKey: string;
  /** File the token was written to (mode 0600). */
  envPath: string;
  /** Config file that was updated, or would have been. */
  configPath: string;
  /** Whether config.json was actually rewritten. */
  wroteConfig: boolean;
}

export interface RelayLoginOptions {
  home: string;
  relayUrl: string;
  email: string;
  password: string;
  /** Set false for `--no-config`: keep only the environment file. */
  writeConfig?: boolean;
}

export interface RelayTokenOptions {
  home: string;
  relayUrl: string;
  token: string;
  writeConfig?: boolean;
}

/** Read a JSON object, treating a missing file as an empty object. */
async function readJsonObject(path: string): Promise<Record<string, unknown>> {
  try {
    const parsed = JSON.parse(await readFile(path, "utf8")) as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as Record<string, unknown> : {};
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return {};
    throw error;
  }
}

function remoteObject(config: Record<string, unknown>): Record<string, unknown> {
  return config.remote && typeof config.remote === "object" && !Array.isArray(config.remote)
    ? config.remote as Record<string, unknown>
    : {};
}

function checkedRelayUrl(value: string): string {
  const relayUrl = normalizeRelayUrl(value);
  let parsed: URL;
  try {
    parsed = new URL(relayUrl);
  } catch {
    throw new Error(`中继地址无效：${value}`);
  }
  if (parsed.protocol !== "https:" && !LOOPBACK.has(parsed.hostname)) {
    throw new Error("账号登录必须使用 HTTPS；只有本机回环地址允许 HTTP");
  }
  return relayUrl;
}

function responseCookie(response: Response): string | undefined {
  const headers = response.headers as Headers & { getSetCookie?: () => string[] };
  const all = headers.getSetCookie ? headers.getSetCookie() : [response.headers.get("set-cookie") ?? ""];
  return all.map(value => value.split(";")[0]!.trim()).find(value => value.startsWith("luban_account="));
}

function fetchFailure(relayUrl: string, error: unknown): Error {
  const detail = error instanceof Error ? error.message : String(error);
  return new Error(`无法连接中继 ${relayUrl}：${detail}`);
}

async function writeEnrollment(options: {
  home: string; relayUrl: string; email: string; token: string; writeConfig: boolean;
}): Promise<RelayEnrollment> {
  const home = resolve(options.home);
  const configPath = join(home, "config.json");
  const config = await readJsonObject(configPath);
  const remoteRaw = remoteObject(config);
  const envKey = (typeof remoteRaw.device_token_env === "string" && remoteRaw.device_token_env.trim())
    || "LUBAN_RELAY_DEVICE_TOKEN";
  if (!/^[A-Z_][A-Z0-9_]*$/u.test(envKey)) throw new Error(`无效的设备令牌变量名：${envKey}`);
  const configuredEnvPath = typeof remoteRaw.node_token_file === "string" ? remoteRaw.node_token_file.trim() : "";
  const envPath = resolve(configuredEnvPath
    || (process.env.LUBAN_HOME?.trim() ? join(home, "relay.env") : join(homedir(), ".config/luban/relay.env")));
  const token = options.token.trim();
  if (!token) throw new Error("中继没有返回设备令牌");

  await mkdir(dirname(envPath), { recursive: true, mode: 0o700 });
  let lines: string[] = [];
  try {
    lines = (await readFile(envPath, "utf8")).split(/\r?\n/u);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  const keyPattern = new RegExp(`^\\s*(?:export\\s+)?${envKey}\\s*=`, "u");
  const kept = lines.filter(line => !keyPattern.test(line));
  while (kept.length > 0 && kept.at(-1) === "") kept.pop();
  kept.push(`${envKey}=${token}`);
  await writeFile(envPath, `${kept.join("\n")}\n`, { mode: 0o600 });
  await chmod(envPath, 0o600);

  if (options.writeConfig) {
    const nextRemote = {
      ...remoteRaw,
      enabled: true,
      relay_url: options.relayUrl,
      device_token_env: envKey,
      node_token_file: envPath,
    };
    await mkdir(home, { recursive: true, mode: 0o700 });
    await writeFile(configPath, `${JSON.stringify({ ...config, remote: nextRemote }, null, 2)}\n`, { mode: 0o600 });
    await chmod(configPath, 0o600);
  }

  return {
    relayUrl: options.relayUrl,
    email: options.email,
    envKey,
    envPath,
    configPath,
    wroteConfig: options.writeConfig,
  };
}

/**
 * Exchange an account password for a device token and persist it where the
 * node already looks for `LUBAN_RELAY_DEVICE_TOKEN`.
 *
 * The password is used once for the request and is never written to disk,
 * config, history or logs. A new token replaces the old one for the account.
 */
export async function loginRelayAccount(options: RelayLoginOptions): Promise<RelayEnrollment> {
  const relayUrl = checkedRelayUrl(options.relayUrl);
  const email = options.email.trim();
  if (!email) throw new Error("缺少邮箱");
  if (!options.password) throw new Error("缺少密码");

  let login: Response;
  try {
    login = await fetch(`${relayUrl}/api/auth/login`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email, password: options.password }),
    });
  } catch (error) {
    throw fetchFailure(relayUrl, error);
  }
  const loginPayload = await login.json().catch(() => ({})) as {
    ok?: boolean; error?: string; account?: { email?: string };
  };
  if (!login.ok || !loginPayload.ok) throw new Error(loginPayload.error || `登录失败：HTTP ${login.status}`);
  const cookie = responseCookie(login);
  if (!cookie) throw new Error("登录成功但没有收到账户 Cookie，请确认中继版本");

  let enrollment: Response;
  try {
    enrollment = await fetch(`${relayUrl}/api/account/device-token`, {
      method: "POST",
      headers: { cookie },
    });
  } catch (error) {
    throw fetchFailure(relayUrl, error);
  }
  const enrollmentPayload = await enrollment.json().catch(() => ({})) as {
    ok?: boolean; error?: string; token?: string;
  };
  if (!enrollment.ok || !enrollmentPayload.ok || !enrollmentPayload.token) {
    throw new Error(enrollmentPayload.error || `生成设备令牌失败：HTTP ${enrollment.status}`);
  }

  return writeEnrollment({
    home: options.home,
    relayUrl,
    email: loginPayload.account?.email || email,
    token: enrollmentPayload.token,
    writeConfig: options.writeConfig !== false,
  });
}

/** Save an existing device token without contacting the relay. */
export async function saveRelayDeviceToken(options: RelayTokenOptions): Promise<RelayEnrollment> {
  const relayUrl = checkedRelayUrl(options.relayUrl);
  return writeEnrollment({
    home: options.home,
    relayUrl,
    email: "",
    token: options.token,
    writeConfig: options.writeConfig !== false,
  });
}
