import { randomBytes } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/**
 * Stable identity for a machine.
 *
 * The relay used to mint a random node id per registration, which is fine for
 * "which laptop answered this request" but useless for "all my computers":
 * every reconnect would look like a new machine. This id lives in the user's
 * luban home and is presented on every relay registration instead.
 */

const DEVICE_ID = /^dev-[a-f0-9]{16,64}$/u;

export interface DeviceIdentity {
  id: string;
  created_at: number;
}

export function readDeviceIdentity(home: string): DeviceIdentity | undefined {
  try {
    const parsed = JSON.parse(readFileSync(join(home, "device.json"), "utf8")) as Partial<DeviceIdentity>;
    if (typeof parsed.id === "string" && DEVICE_ID.test(parsed.id)) {
      return { id: parsed.id, created_at: Number(parsed.created_at) || 0 };
    }
  } catch { /* missing or malformed: create a new one below */ }
  return undefined;
}

export function ensureDeviceIdentity(home: string): DeviceIdentity {
  const existing = readDeviceIdentity(home);
  if (existing) return existing;
  const identity: DeviceIdentity = {
    id: `dev-${randomBytes(12).toString("hex")}`,
    created_at: Date.now(),
  };
  mkdirSync(home, { recursive: true, mode: 0o700 });
  const path = join(home, "device.json");
  const temporary = `${path}.${process.pid}.tmp`;
  writeFileSync(temporary, `${JSON.stringify(identity, null, 2)}\n`, { mode: 0o600 });
  renameSync(temporary, path);
  return identity;
}
