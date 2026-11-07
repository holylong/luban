// Run the installed CLI in production by default. This module must load before
// React/Ink: React's development performance measures accumulate in Node.
// Preserve an explicitly selected development or test environment.
process.env.NODE_ENV ||= "production";

import { createRequire } from "node:module";
import { dirname } from "node:path";

/**
 * True when the process is a Node single executable application (SEA).
 *
 * A SEA binary carries no node_modules and no package.json, so `import.meta.url`
 * points at the executable instead of dist/. Resource lookups have to follow
 * `resourceRoot()` rather than the module location.
 */
export function isSeaRuntime(): boolean {
  try {
    const sea = createRequire(import.meta.url)("node:sea") as { isSea?: () => boolean };
    return sea.isSea?.() === true;
  } catch {
    // Older Node releases have no node:sea module; they never run as a SEA.
    return false;
  }
}

/** Directory that ships `assets/` and `web-ui/` beside a SEA executable. */
export function resourceRoot(): string | undefined {
  return isSeaRuntime() ? dirname(process.execPath) : undefined;
}
