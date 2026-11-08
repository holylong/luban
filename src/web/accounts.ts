import { createHash, randomBytes, scrypt as scryptCallback, timingSafeEqual } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { promisify } from "node:util";

/**
 * Accounts for the public relay.
 *
 * The relay used to have one access token shared by every phone. That is enough
 * for one owner with one laptop, but not for "all my computers": a token cannot
 * say which account a laptop belongs to, and losing one phone would hand over
 * every node on the relay. This store adds the missing ownership layer while
 * keeping the tunnel itself unchanged.
 *
 * Passwords are scrypt hashes; session and device-enrollment tokens are stored
 * as SHA-256 hashes, so a copy of the JSON file cannot be replayed as a login.
 * The file is written with 0600 permissions and replaced atomically.
 */

export const ACCOUNT_COOKIE = "luban_account";
export const SESSION_TTL_SECONDS = 60 * 60 * 24 * 30;

const scrypt = promisify(scryptCallback);
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/u;
const ID = /^[A-Za-z0-9_-]{6,80}$/u;

export interface RelayAccountView {
  id: string;
  email: string;
  created_at: number;
  has_device_token: boolean;
}

export interface RelayStoredDevice {
  id: string;
  account_id: string;
  name: string;
  workspace: string;
  projects: Record<string, string>;
  created_at: number;
  last_seen_at: number;
}

export interface AccountSession {
  account: RelayAccountView;
  token: string;
}

interface StoredAccount {
  id: string;
  email: string;
  salt: string;
  password_hash: string;
  created_at: number;
  device_token_hash?: string;
}

interface StoredSession {
  token_hash: string;
  account_id: string;
  created_at: number;
  expires_at: number;
}

interface StoreData {
  version: 1;
  accounts: StoredAccount[];
  sessions: StoredSession[];
  devices: RelayStoredDevice[];
}

export class AccountError extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
  }
}

function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

function validId(value: string): boolean {
  return ID.test(value);
}

export function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

function view(account: StoredAccount): RelayAccountView {
  return {
    id: account.id,
    email: account.email,
    created_at: account.created_at,
    has_device_token: Boolean(account.device_token_hash),
  };
}

export class RelayAccountStore {
  private data: StoreData = { version: 1, accounts: [], sessions: [], devices: [] };
  private writes: Promise<void> = Promise.resolve();
  private initialized = false;

  constructor(readonly path?: string) {}

  async initialize(): Promise<void> {
    if (this.initialized) return;
    if (this.path) {
      try {
        const parsed = JSON.parse(await readFile(this.path, "utf8")) as Partial<StoreData>;
        if (parsed?.version !== 1 || !Array.isArray(parsed.accounts) || !Array.isArray(parsed.sessions) || !Array.isArray(parsed.devices)) {
          throw new Error("unsupported account file format");
        }
        this.data = {
          version: 1,
          accounts: parsed.accounts,
          sessions: parsed.sessions,
          devices: parsed.devices,
        };
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
    }
    this.purgeExpired();
    this.initialized = true;
  }

  private requireReady(): void {
    if (!this.initialized) throw new Error("account store is not initialized");
  }

  private purgeExpired(now = Date.now()): void {
    this.data.sessions = this.data.sessions.filter(session => session.expires_at > now);
    // Devices are kept for offline visibility; only a deliberate removal drops
    // one. Sessions are the only unbounded record set, hence the purge above.
  }

  private async persist(): Promise<void> {
    if (!this.path) return;
    this.purgeExpired();
    const body = `${JSON.stringify(this.data, null, 2)}\n`;
    this.writes = this.writes.then(async () => {
      await mkdir(dirname(this.path!), { recursive: true, mode: 0o700 });
      const temporary = `${this.path}.${process.pid}.${randomBytes(3).toString("hex")}.tmp`;
      await writeFile(temporary, body, { mode: 0o600 });
      await rename(temporary, this.path!);
    });
    await this.writes;
  }

  private findAccountByEmail(email: string): StoredAccount | undefined {
    return this.data.accounts.find(account => account.email === email);
  }

  private findAccount(id: string): StoredAccount | undefined {
    return this.data.accounts.find(account => account.id === id);
  }

  /** Used by registration-code sending without exposing stored records. */
  async hasAccount(email: string): Promise<boolean> {
    this.requireReady();
    return Boolean(this.findAccountByEmail(normalizeEmail(email)));
  }

  async register(email: string, password: string): Promise<RelayAccountView> {
    this.requireReady();
    const normalized = normalizeEmail(email);
    if (!EMAIL.test(normalized) || normalized.length > 254) throw new AccountError(400, "请输入有效的邮箱地址");
    if (password.length < 8 || password.length > 200) throw new AccountError(400, "密码至少 8 位，最多 200 位");
    if (this.findAccountByEmail(normalized)) throw new AccountError(409, "该邮箱已注册，请直接登录");
    const salt = randomBytes(16).toString("base64url");
    const passwordHash = (await scrypt(password, salt, 64)) as Buffer;
    // Two concurrent registrations can both pass the check above while scrypt
    // runs; re-check before committing so the file cannot contain duplicate
    // emails (which would make login ambiguous).
    if (this.findAccountByEmail(normalized)) throw new AccountError(409, "该邮箱已注册，请直接登录");
    const account: StoredAccount = {
      id: `a-${randomBytes(10).toString("hex")}`,
      email: normalized,
      salt,
      password_hash: passwordHash.toString("hex"),
      created_at: Date.now(),
    };
    this.data.accounts.push(account);
    await this.persist();
    return view(account);
  }

  async login(email: string, password: string): Promise<AccountSession> {
    this.requireReady();
    const normalized = normalizeEmail(email);
    const account = this.findAccountByEmail(normalized);
    if (!account) {
      // Spend the same scrypt time as a real check so response time does not
      // reveal whether an email is registered.
      await scrypt(password, "luban-dummy-salt", 64).catch(() => undefined);
      throw new AccountError(401, "邮箱或密码错误");
    }
    const actual = Buffer.from(account.password_hash, "hex");
    const candidate = (await scrypt(password, account.salt, actual.length)) as Buffer;
    if (actual.length !== candidate.length || !timingSafeEqual(actual, candidate)) {
      throw new AccountError(401, "邮箱或密码错误");
    }
    return this.issueSession(account);
  }

  private async issueSession(account: StoredAccount): Promise<AccountSession> {
    const token = randomBytes(32).toString("base64url");
    const now = Date.now();
    this.data.sessions.push({
      token_hash: hashToken(token),
      account_id: account.id,
      created_at: now,
      expires_at: now + SESSION_TTL_SECONDS * 1000,
    });
    await this.persist();
    return { account: view(account), token };
  }

  async session(token: string | undefined): Promise<RelayAccountView | undefined> {
    this.requireReady();
    if (!token) return undefined;
    const hashed = hashToken(token);
    const record = this.data.sessions.find(session => session.token_hash === hashed);
    if (!record) return undefined;
    if (record.expires_at <= Date.now()) {
      this.data.sessions = this.data.sessions.filter(session => session !== record);
      await this.persist();
      return undefined;
    }
    const account = this.findAccount(record.account_id);
    return account ? view(account) : undefined;
  }

  async logout(token: string | undefined): Promise<void> {
    this.requireReady();
    if (!token) return;
    const hashed = hashToken(token);
    const before = this.data.sessions.length;
    this.data.sessions = this.data.sessions.filter(session => session.token_hash !== hashed);
    if (this.data.sessions.length !== before) await this.persist();
  }

  /**
   * Create (or rotate) the one device-enrollment token for an account. The
   * plaintext is returned once; only its hash is written to disk.
   */
  async createDeviceToken(accountId: string): Promise<string> {
    this.requireReady();
    const account = this.findAccount(accountId);
    if (!account) throw new AccountError(404, "账户不存在");
    const token = randomBytes(24).toString("base64url");
    account.device_token_hash = hashToken(token);
    await this.persist();
    return token;
  }

  async accountForDeviceToken(token: string | undefined): Promise<RelayAccountView | undefined> {
    this.requireReady();
    if (!token) return undefined;
    const hashed = hashToken(token);
    const account = this.data.accounts.find(item => item.device_token_hash === hashed);
    return account ? view(account) : undefined;
  }

  async upsertDevice(accountId: string, input: {
    id: string;
    name: string;
    workspace: string;
    projects: Record<string, string>;
  }): Promise<RelayStoredDevice> {
    this.requireReady();
    if (!validId(input.id)) throw new AccountError(400, "invalid device id");
    if (!this.findAccount(accountId)) throw new AccountError(404, "账户不存在");
    const now = Date.now();
    let device = this.data.devices.find(item => item.id === input.id && item.account_id === accountId);
    if (device) {
      device.name = input.name;
      device.workspace = input.workspace;
      device.projects = input.projects;
      device.last_seen_at = now;
    } else {
      device = {
        id: input.id,
        account_id: accountId,
        name: input.name,
        workspace: input.workspace,
        projects: input.projects,
        created_at: now,
        last_seen_at: now,
      };
      this.data.devices.push(device);
    }
    await this.persist();
    return device;
  }

  async devices(accountId: string): Promise<RelayStoredDevice[]> {
    this.requireReady();
    return this.data.devices
      .filter(device => device.account_id === accountId)
      .sort((left, right) => right.last_seen_at - left.last_seen_at);
  }

  async removeDevice(accountId: string, deviceId: string): Promise<boolean> {
    this.requireReady();
    const before = this.data.devices.length;
    this.data.devices = this.data.devices.filter(device => !(device.account_id === accountId && device.id === deviceId));
    if (this.data.devices.length === before) return false;
    await this.persist();
    return true;
  }
}

export function accountCookie(token: string, maxAgeSeconds = SESSION_TTL_SECONDS, secure = false): string {
  return `${ACCOUNT_COOKIE}=${encodeURIComponent(token)}; Path=/; Max-Age=${maxAgeSeconds}; HttpOnly; SameSite=Lax${secure ? "; Secure" : ""}`;
}

export function clearAccountCookie(secure = false): string {
  return `${ACCOUNT_COOKIE}=; Path=/; Max-Age=0; HttpOnly; SameSite=Lax${secure ? "; Secure" : ""}`;
}

/** A simple per-address throttle for register/login, separate from node auth. */
export class AuthThrottle {
  private readonly attempts = new Map<string, number[]>();
  constructor(private readonly limit = 12, private readonly windowMs = 10 * 60_000, private readonly now = Date.now) {}

  check(key: string): boolean {
    const cutoff = this.now() - this.windowMs;
    const kept = (this.attempts.get(key) ?? []).filter(at => at > cutoff);
    if (kept.length >= this.limit) {
      this.attempts.set(key, kept);
      return false;
    }
    kept.push(this.now());
    this.attempts.set(key, kept);
    return true;
  }

  reset(key: string): void {
    this.attempts.delete(key);
  }
}

export function defaultAccountsPath(home: string): string {
  return join(home, "relay-accounts.json");
}
