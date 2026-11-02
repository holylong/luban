import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { BotPermissions, parseBotPolicy } from "./bot-permissions.js";
const homes: string[] = [];
afterEach(async () => { await Promise.all(homes.splice(0).map(path => rm(path, { recursive: true, force: true }))); });
async function setup() {
  const home = await mkdtemp(join(tmpdir(), "bot-permissions-")); homes.push(home);
  return { home, permissions: new BotPermissions(home) };
}
it("defaults to no grants and initialization never overwrites user grants", async () => {
  const { home, permissions } = await setup();
  expect(await permissions.allows(home, "bash", { command: "npm test" })).toBe(false);
  await permissions.init();
  const policy = { version: 1, grants: [{ workspace: home, tool: "bash", args: { command: "npm test", timeout: 60 }, expiresAt: "2099-01-01T00:00:00Z" }], emergency: [] };
  await writeFile(permissions.policyPath, JSON.stringify(policy));
  await permissions.init();
  expect(await permissions.read()).toEqual(policy);
  expect(await permissions.allows(home, "bash", { timeout: 60, command: "npm test" })).toBe(true);
  expect(await permissions.allows(home, "bash", { command: "npm test" })).toBe(false);
  expect(await permissions.allows(home, "bash", { command: "npm test; rm x", timeout: 60 })).toBe(false);
  expect(await permissions.allows(tmpdir(), "bash", { command: "npm test", timeout: 60 })).toBe(false);
});
it("separates emergency grants, honors expiry and reloads revocations", async () => {
  const { home, permissions } = await setup(); await permissions.init();
  const grant = { workspace: home, tool: "stop_background_task", args: { task_id: "owned-task" }, expiresAt: "2099-01-01T00:00:00Z" };
  await writeFile(permissions.policyPath, JSON.stringify({ version: 1, grants: [], emergency: [grant] }));
  expect(await permissions.allows(home, grant.tool, grant.args)).toBe(false);
  expect(await permissions.allows(home, grant.tool, grant.args, true)).toBe(true);
  expect(await permissions.allows(home, grant.tool, grant.args, true, Date.parse("2100-01-01"))).toBe(false);
  await writeFile(permissions.policyPath, JSON.stringify({ version: 1, grants: [], emergency: [] }));
  expect(await permissions.allows(home, grant.tool, grant.args, true)).toBe(false);
});
it("rejects malformed/unknown policy fields and records exact permission requests", async () => {
  const { home, permissions } = await setup(); await permissions.init();
  expect(() => parseBotPolicy({ version: 1, grants: [], emergency: [], allowAll: true })).toThrow();
  expect(() => parseBotPolicy({ version: 1, grants: [{ workspace: ".", tool: "*", args: {}, expiresAt: "never" }], emergency: [] })).toThrow();
  await writeFile(permissions.policyPath, "invalid json");
  await expect(permissions.allows(home, "bash", {})).rejects.toThrow();
  const id = await permissions.request("task", home, "bash", { command: "npm test" }, "No grant");
  expect(JSON.parse(await readFile(join(permissions.requestsPath, `${id}.json`), "utf8"))).toMatchObject({ taskId: "task", workspace: home, tool: "bash", args: { command: "npm test" }, status: "pending" });
});
