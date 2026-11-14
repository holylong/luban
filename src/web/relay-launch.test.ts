import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { LubanConfig } from "../core/types.js";
import { readEnvFileValue, relayLaunchSettings } from "./relay-launch.js";

const NODE_ENV = "LUBAN_TEST_RELAY_LAUNCH_NODE";
const DEVICE_ENV = "LUBAN_TEST_RELAY_LAUNCH_DEVICE";
let home = "";
let envFile = "";

function config(overrides: Partial<LubanConfig["remote"]> = {}): LubanConfig {
  return {
    remote: {
      enabled: true,
      host: "127.0.0.1",
      port: 0,
      relayUrl: "https://relay.example",
      nodeTokenEnv: NODE_ENV,
      nodeTokenFile: envFile,
      deviceTokenEnv: DEVICE_ENV,
      relayCa: "",
      ...overrides,
    },
  } as LubanConfig;
}

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "luban-relay-launch-"));
  envFile = join(home, "relay.env");
  delete process.env[NODE_ENV];
  delete process.env[DEVICE_ENV];
});

afterEach(() => {
  delete process.env[NODE_ENV];
  delete process.env[DEVICE_ENV];
  rmSync(home, { recursive: true, force: true });
});

describe("relay launch settings", () => {
  it("reads the config remote block and its token file", () => {
    writeFileSync(envFile, [
      "LUBAN_OTHER=nope",
      `${NODE_ENV}=node-from-file`,
      `export ${DEVICE_ENV}='device-from-file'`,
    ].join("\n"));
    expect(relayLaunchSettings(config(), { remote: true })).toEqual({
      relayUrl: "https://relay.example",
      nodeToken: "node-from-file",
      deviceToken: "device-from-file",
      relayCa: "",
    });
  });

  it("lets explicit flags and environment variables win", () => {
    writeFileSync(envFile, `${NODE_ENV}=file-node\n${DEVICE_ENV}=file-device\n`);
    process.env[NODE_ENV] = "env-node";
    expect(relayLaunchSettings(config(), {
      remote: true,
      relay: "http://127.0.0.1:9000",
      relayToken: "flag-node",
      relayDeviceToken: "flag-device",
      relayCa: "/tmp/ca.pem",
    })).toEqual({
      relayUrl: "http://127.0.0.1:9000",
      nodeToken: "flag-node",
      deviceToken: "flag-device",
      relayCa: "/tmp/ca.pem",
    });
  });

  it("does nothing when remote control is disabled", () => {
    expect(relayLaunchSettings(config({ enabled: false }), { remote: true })).toBeUndefined();
  });

  it("keeps the legacy env-token fallback for an explicit --relay", () => {
    process.env.LUBAN_RELAY_NODE_TOKEN = "legacy-node";
    try {
      expect(relayLaunchSettings(config({ enabled: false }), { relay: "https://relay.example" })).toEqual({
        relayUrl: "https://relay.example",
        nodeToken: "legacy-node",
        deviceToken: "",
        relayCa: "",
      });
    } finally {
      delete process.env.LUBAN_RELAY_NODE_TOKEN;
    }
  });

  it("reads exported and quoted env-file values", () => {
    writeFileSync(envFile, `export ${NODE_ENV}="quoted value"\n`);
    expect(readEnvFileValue(envFile, NODE_ENV)).toBe("quoted value");
  });
});

it("gives the desktop's relay slot to the daemon, not to a window backend", () => {
  const desktop = readFileSync(new URL("../../apps/desktop/main.cjs", import.meta.url), "utf8");
  const daemon = readFileSync(new URL("./daemon.ts", import.meta.url), "utf8");
  expect(desktop).toContain('"--no-mesh"');
  // A device holds one relay slot, so exactly one process may dial it. The
  // window backend dies with the app; the daemon outlives it and keeps the
  // phone's device card alive, so the slot belongs to the daemon.
  expect(desktop).not.toContain('args.push("--remote")');
  expect(daemon).toContain('"--remote"');
  // The window backend must still die with the app, or abandoned windows leave
  // orphaned servers behind.
  expect(desktop).toContain('"--parent-pid", String(process.pid)');
  // ...and every window hands its folder to the daemon for the phone.
  expect(desktop).toContain('spawn(node, [cli, "daemon", "start", workspace]');
});
