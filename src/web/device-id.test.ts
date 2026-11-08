import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ensureDeviceIdentity, instanceDeviceId, readDeviceIdentity } from "./device-id.js";

let home: string;

beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), "luban-device-"));
});

afterEach(async () => {
  await rm(home, { recursive: true, force: true });
});

describe("device identity", () => {
  it("creates one stable machine id and reuses it", async () => {
    const first = ensureDeviceIdentity(home);
    const second = ensureDeviceIdentity(home);
    expect(first.id).toMatch(/^dev-[a-f0-9]{24}$/u);
    expect(second.id).toBe(first.id);
    expect(readDeviceIdentity(home)?.id).toBe(first.id);
    if (process.platform !== "win32") expect((await stat(join(home, "device.json"))).mode & 0o777).toBe(0o600);
  });

  it("replaces a malformed identity instead of trusting it", async () => {
    await writeFile(join(home, "device.json"), JSON.stringify({ id: "node-123" }));
    const identity = ensureDeviceIdentity(home);
    expect(identity.id).toMatch(/^dev-[a-f0-9]{24}$/u);
    expect(JSON.parse(await readFile(join(home, "device.json"), "utf8")).id).toBe(identity.id);
  });

  it("gives each workspace its own stable instance id", () => {
    const machine = ensureDeviceIdentity(home).id;
    const api = instanceDeviceId(home, join(home, "projects", "api"));
    const web = instanceDeviceId(home, join(home, "projects", "web"));

    expect(api).toMatch(/^dev-[a-f0-9]{24}-[a-f0-9]{16}$/u);
    expect(api.startsWith(`${machine}-`)).toBe(true);
    expect(instanceDeviceId(home, join(home, "projects", "api", "..", "api"))).toBe(api);
    expect(web).not.toBe(api);
  });
});
