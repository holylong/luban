import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AccountError, RelayAccountStore } from "./accounts.js";

let root: string;
let path: string;
let store: RelayAccountStore;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "luban-accounts-"));
  path = join(root, "relay-accounts.json");
  store = new RelayAccountStore(path);
  await store.initialize();
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

describe("relay accounts", () => {
  it("registers, logs in and restores a session from disk", async () => {
    const account = await store.register("Owner@Example.com", "correct horse");
    expect(account.email).toBe("owner@example.com");
    const session = await store.login("owner@example.com", "correct horse");
    expect(session.account.id).toBe(account.id);
    expect(session.token.length).toBeGreaterThan(30);

    const reopened = new RelayAccountStore(path);
    await reopened.initialize();
    expect((await reopened.session(session.token))?.id).toBe(account.id);
    await reopened.logout(session.token);
    expect(await reopened.session(session.token)).toBeUndefined();
  });

  it("rejects duplicate emails, short passwords and wrong credentials", async () => {
    await store.register("a@example.com", "password-1");
    await expect(store.register("A@example.com", "password-2")).rejects.toMatchObject({ status: 409 });
    await expect(store.register("b@example.com", "short")).rejects.toMatchObject({ status: 400 });
    await expect(store.register("not-an-email", "password-1")).rejects.toMatchObject({ status: 400 });
    await expect(store.login("a@example.com", "wrong-password")).rejects.toMatchObject({ status: 401 });
    await expect(store.login("missing@example.com", "password-1")).rejects.toMatchObject({ status: 401 });
  });

  it("stores only hashes and keeps the file private", async () => {
    const account = await store.register("secret@example.com", "password-1");
    const session = await store.login("secret@example.com", "password-1");
    const deviceToken = await store.createDeviceToken(account.id);
    const raw = await readFile(path, "utf8");
    expect(raw).not.toContain("password-1");
    expect(raw).not.toContain(session.token);
    expect(raw).not.toContain(deviceToken);
    expect(raw).toContain("password_hash");
    expect(raw).toContain("token_hash");
    if (process.platform !== "win32") expect((await stat(path)).mode & 0o777).toBe(0o600);
    expect(await store.accountForDeviceToken(deviceToken)).toMatchObject({ id: account.id });
    expect(await store.accountForDeviceToken("nope")).toBeUndefined();
  });

  it("rotates the device token so an old machine enrollment stops working", async () => {
    const account = await store.register("devices@example.com", "password-1");
    const first = await store.createDeviceToken(account.id);
    expect((await store.accountForDeviceToken(first))?.id).toBe(account.id);
    const second = await store.createDeviceToken(account.id);
    expect(await store.accountForDeviceToken(first)).toBeUndefined();
    expect((await store.accountForDeviceToken(second))?.id).toBe(account.id);
  });

  it("persists devices for offline visibility and removes them on request", async () => {
    const account = await store.register("devices@example.com", "password-1");
    await store.upsertDevice(account.id, {
      id: "dev-aaaaaaaaaaaaaaaa",
      name: "laptop",
      workspace: "/tmp/work",
      projects: { demo: "/tmp/work/demo" },
    });
    const reopened = new RelayAccountStore(path);
    await reopened.initialize();
    expect(await reopened.devices(account.id)).toMatchObject([
      { id: "dev-aaaaaaaaaaaaaaaa", name: "laptop", workspace: "/tmp/work" },
    ]);
    expect(await reopened.removeDevice(account.id, "dev-aaaaaaaaaaaaaaaa")).toBe(true);
    expect(await reopened.removeDevice(account.id, "dev-aaaaaaaaaaaaaaaa")).toBe(false);
    expect(await reopened.devices(account.id)).toEqual([]);
  });

  it("rejects malformed account files instead of silently starting empty", async () => {
    const badPath = join(root, "bad.json");
    await import("node:fs/promises").then(fs => fs.writeFile(badPath, "{\"version\":9}"));
    const bad = new RelayAccountStore(badPath);
    await expect(bad.initialize()).rejects.toThrow(/unsupported account file format/u);
  });

  it("exposes account errors with HTTP statuses", () => {
    expect(new AccountError(409, "x").status).toBe(409);
  });
});
