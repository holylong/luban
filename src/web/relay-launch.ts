import { existsSync, readFileSync } from "node:fs";
import type { LubanConfig } from "../core/types.js";

export interface RelayLaunchOverrides {
  relay?: string;
  relayToken?: string;
  relayDeviceToken?: string;
  relayCa?: string;
  /** Use the `remote` block from config when no explicit relay URL was given. */
  remote?: boolean;
}

export interface RelayLaunchSettings {
  relayUrl: string;
  nodeToken: string;
  deviceToken: string;
  /** PEM file path, not the PEM body. */
  relayCa: string;
}

/** Read `KEY=value` (or `export KEY=value`) from a token env file. */
export function readEnvFileValue(path: string, key: string): string {
  if (!existsSync(path)) return "";
  const prefix = new RegExp(`^\\s*(?:export\\s+)?${key}\\s*=(.*)$`, "u");
  for (const line of readFileSync(path, "utf8").split(/\r?\n/u)) {
    const match = line.match(prefix);
    if (!match) continue;
    return match[1]!.trim().replace(/^(['"])(.*)\1$/u, "$2");
  }
  return "";
}

/**
 * Resolve one tunnel launch from explicit flags or the config `remote` block.
 *
 * Explicit flags win; `--remote` only fills what the operator did not pass on
 * the command line. Keeping this separate from the daemon lets the desktop app
 * use the same relay credentials as the TUI without duplicating config parsing.
 */
export function relayLaunchSettings(config: LubanConfig, overrides: RelayLaunchOverrides): RelayLaunchSettings | undefined {
  const remote = overrides.remote && config.remote.enabled ? config.remote : undefined;
  if (!overrides.relay?.trim() && !remote) return undefined;
  const env = (name: string): string => process.env[name]?.trim() ?? "";
  const nodeTokenEnv = remote?.nodeTokenEnv || "LUBAN_RELAY_NODE_TOKEN";
  const deviceTokenEnv = remote?.deviceTokenEnv || "LUBAN_RELAY_DEVICE_TOKEN";
  return {
    relayUrl: overrides.relay?.trim() || remote?.relayUrl.trim() || "",
    nodeToken: overrides.relayToken?.trim() || env(nodeTokenEnv)
      || (remote ? readEnvFileValue(remote.nodeTokenFile, remote.nodeTokenEnv) : ""),
    deviceToken: overrides.relayDeviceToken?.trim() || env(deviceTokenEnv)
      || (remote ? readEnvFileValue(remote.nodeTokenFile, remote.deviceTokenEnv) : ""),
    relayCa: overrides.relayCa?.trim() || remote?.relayCa || "",
  };
}
