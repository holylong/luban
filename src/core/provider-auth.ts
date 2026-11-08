import { readFileSync } from "node:fs";
import { mkdir, rename, unlink, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { join, resolve } from "node:path";

const writes = new Map<string, Promise<void>>();

function validProvider(provider: string): boolean {
  return /^[a-zA-Z0-9][a-zA-Z0-9_-]*$/.test(provider)
    && !["__proto__", "constructor", "prototype"].includes(provider);
}

function validKey(key: unknown): key is string {
  return typeof key === "string" && key.trim().length > 0 && !/[\x00-\x1f\x7f-\x9f\u2028\u2029]/u.test(key);
}

/** Read only the user's plaintext credential store, never a workspace config. */
export function readProviderKeys(home: string): Record<string, string> {
  let source: string;
  try {
    source = readFileSync(join(home, "provider-auth.json"), "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return {};
    throw new Error("Unable to read provider credentials.");
  }
  try {
    const parsed: unknown = JSON.parse(source);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error();
    const entries = Object.entries(parsed);
    if (entries.some(([provider, key]) => !validProvider(provider) || !validKey(key))) throw new Error();
    return Object.fromEntries(entries);
  } catch {
    // Do not expose JSON parser messages, which can include credential text.
    throw new Error("Invalid provider credential file.");
  }
}

/** Serialize read/modify/atomic-replace operations per user home in this process. */
export async function saveProviderKey(home: string, provider: string, key: string | null): Promise<void> {
  if (!validProvider(provider)) throw new Error("Invalid provider name.");
  if (key !== null && !validKey(key)) throw new Error("Invalid provider API key.");
  const directory = resolve(home);
  const previous = writes.get(directory) ?? Promise.resolve();
  const pending = previous.catch(() => {}).then(async () => {
    // Read strictly before touching the file: corrupt stores must not be lost.
    const keys = readProviderKeys(directory);
    if (key === null) delete keys[provider];
    else keys[provider] = key;
    await mkdir(directory, { recursive: true, mode: 0o700 });
    const temporary = join(directory, `.provider-auth-${randomUUID()}.tmp`);
    try {
      await writeFile(temporary, `${JSON.stringify(keys, null, 2)}\n`, { mode: 0o600, flag: "wx" });
      await rename(temporary, join(directory, "provider-auth.json"));
    } finally {
      await unlink(temporary).catch(() => {});
    }
  });
  writes.set(directory, pending);
  try {
    await pending;
  } finally {
    if (writes.get(directory) === pending) writes.delete(directory);
  }
}
