import { randomUUID } from "node:crypto";
import { mkdir, readFile, realpath, writeFile } from "node:fs/promises";
import { join, isAbsolute } from "node:path";

export interface BotGrant {
  workspace: string;
  tool: string;
  args: Record<string, unknown>;
  expiresAt: string;
}
export interface BotPolicy { version: 1; grants: BotGrant[]; emergency: BotGrant[] }
export const emptyBotPolicy: BotPolicy = { version: 1, grants: [], emergency: [] };

function object(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
function exactKeys(value: Record<string, unknown>, keys: string[]) {
  return Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key));
}
export function parseBotPolicy(value: unknown): BotPolicy {
  if (!object(value) || !exactKeys(value, ["version", "grants", "emergency"]) || value.version !== 1
    || !Array.isArray(value.grants) || !Array.isArray(value.emergency)) throw new Error("Invalid bot permissions policy");
  for (const grant of [...value.grants, ...value.emergency]) {
    if (!object(grant) || !exactKeys(grant, ["workspace", "tool", "args", "expiresAt"])
      || typeof grant.workspace !== "string" || !isAbsolute(grant.workspace)
      || typeof grant.tool !== "string" || !/^[a-z][a-z0-9_]*$/.test(grant.tool)
      || !object(grant.args) || typeof grant.expiresAt !== "string" || !Number.isFinite(Date.parse(grant.expiresAt))) {
      throw new Error("Invalid bot permission grant: exact workspace/tool/args and expiry required");
    }
  }
  return value as unknown as BotPolicy;
}
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (object(value)) return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonical(value[key])}`).join(",")}}`;
  return JSON.stringify(value);
}

/** No globs, argument prefixes, implicit emergency escalation or persistent "always" approvals. */
export class BotPermissions {
  readonly policyPath: string;
  readonly requestsPath: string;
  constructor(home: string) {
    this.policyPath = join(home, "bot", "permissions.json");
    this.requestsPath = join(home, "bot", "permission-requests");
  }
  async init() {
    await mkdir(this.requestsPath, { recursive: true, mode: 0o700 });
    await writeFile(this.policyPath, JSON.stringify(emptyBotPolicy, null, 2) + "\n", { flag: "wx", mode: 0o600 })
      .catch(error => { if (error.code !== "EEXIST") throw error; });
  }
  async read(): Promise<BotPolicy> {
    try { return parseBotPolicy(JSON.parse(await readFile(this.policyPath, "utf8"))); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return { version: 1, grants: [], emergency: [] };
      throw error; // malformed configuration is never interpreted as authorization
    }
  }
  async allows(workspace: string, tool: string, args: Record<string, unknown>, emergency = false, now = Date.now()) {
    const policy = await this.read(); // reload for every approval: edits/revocations take effect immediately
    const actual = await realpath(workspace);
    for (const grant of emergency ? policy.emergency : policy.grants) {
      if (Date.parse(grant.expiresAt) <= now || grant.tool !== tool || canonical(grant.args) !== canonical(args)) continue;
      // A missing/moved project never inherits another project's authority.
      if (await realpath(grant.workspace).catch(() => null) === actual) return true;
    }
    return false;
  }
  async request(taskId: string, workspace: string, tool: string, args: Record<string, unknown>, reason: string) {
    await mkdir(this.requestsPath, { recursive: true, mode: 0o700 });
    const id = randomUUID();
    await writeFile(join(this.requestsPath, `${id}.json`), JSON.stringify({
      id, taskId, workspace, tool, args, reason, status: "pending", createdAt: new Date().toISOString(),
    }, null, 2) + "\n", { flag: "wx", mode: 0o600 });
    return id;
  }
}
