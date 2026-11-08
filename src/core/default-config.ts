import { constants, copyFileSync, existsSync, linkSync, mkdirSync, unlinkSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { join } from "node:path";

/**
 * Portable starter configuration for a fresh install.
 *
 * This is the author's working setup with everything machine- or account-bound
 * removed: no API keys, custom gateways, LAN peers, relay URLs or project paths.
 * Provider catalogs stay built in, so omitting `providers` keeps them current
 * instead of freezing today's model lists in every new install.
 *
 * The active model is a credential-free OpenCode Zen free tier model, so a fresh
 * install can send a first message before the user configures any key.
 */
export const STARTER_CONFIG = {
  node: {
    host: "0.0.0.0",
    port: 17890,
    udp_port: 7891,
  },
  model: {
    active: "opencode-zen/deepseek-v4.1-flash-free",
    temperature: 0.2,
    top_p: 1,
    top_k: 0,
    timeout: 300,
    thinking_timeout: 600,
    max_retries: 5,
    context_window: 262144,
    max_history_messages: 60,
    reasoning_effort: "xhigh",
  },
  sync: {
    mode: "auto",
    chunk_size: 65536,
    ignore: [
      ".git",
      ".luban",
      ".dagent",
      "__pycache__",
      ".pytest_cache",
      ".ruff_cache",
      ".mypy_cache",
      ".venv",
      "venv",
      "node_modules",
      "target",
      "*.pyc",
      "*.pyo",
      ".DS_Store",
      "*.log",
    ],
    conflict_policy: "auto",
  },
  max_workers: 12,
  max_steps: 1000,
  // Approval stays on for shell and network tools. A shipped "allow" default
  // would grant every future install unattended command execution.
  permission: {
    mode: "edits",
  },
} as const;

export function starterConfigSource(): string {
  return `${JSON.stringify(STARTER_CONFIG, null, 2)}\n`;
}

/**
 * Materialise the starter config exactly once. An existing configuration is
 * never read or rewritten, so upgrades and user edits always win. The file is
 * created atomically and, on Unix, readable only by the owner.
 *
 * A failure here must not stop startup: the built-in defaults still work.
 */
export function ensureStarterConfig(home: string): "created" | "exists" | "failed" {
  const path = join(home, "config.json");
  if (existsSync(path)) return "exists";
  const temporary = join(home, `.config-${process.pid}-${randomUUID()}.tmp`);
  try {
    mkdirSync(home, { recursive: true, mode: 0o700 });
    writeFileSync(temporary, starterConfigSource(), { mode: 0o600, flag: "wx" });
    try {
      // link() fails when another process won the first-run race, so an
      // existing config is never replaced by the template.
      linkSync(temporary, path);
      return "created";
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EEXIST") return "exists";
      // Some Windows/FAT/network mounts have no hard links: copy with an
      // exclusive flag, which still refuses to replace an existing config.
      try {
        copyFileSync(temporary, path, constants.COPYFILE_EXCL);
        return "created";
      } catch (copyError) {
        if ((copyError as NodeJS.ErrnoException).code === "EEXIST") return "exists";
        throw copyError;
      }
    }
  } catch {
    return "failed";
  } finally {
    try { unlinkSync(temporary); } catch { /* already removed or never created */ }
  }
}
