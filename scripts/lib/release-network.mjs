import { join } from "node:path";
import { spawnSync } from "node:child_process";

export function releaseEnvironment(env = process.env) {
  return { ...env,
    ELECTRON_MIRROR: env.ELECTRON_MIRROR || env.npm_config_electron_mirror || "https://npmmirror.com/mirrors/electron/",
  };
}

export function ensureElectron(root) {
  const result = spawnSync(process.execPath, [join(root, "node_modules", "electron", "install.js")], {
    cwd: root, env: releaseEnvironment(), stdio: ["ignore", "inherit", "inherit"], timeout: 180000,
  });
  if (result.error || result.status !== 0) {
    throw new Error("Electron runtime unavailable. Download uses ELECTRON_MIRROR (default: npmmirror). Retry with a reachable mirror, or run npm run release -- --kind cli to build a ZIP without Electron.");
  }
}

export function installRuntime(root, app, npmCli) {
  const args = [npmCli, "ci", "--omit=dev", "--ignore-scripts", "--no-audit", "--no-fund"];
  const options = { cwd: app, env: releaseEnvironment(), stdio: ["ignore", "inherit", "inherit"] };
  console.log("Install runtime dependencies from npm cache (offline)");
  const cached = spawnSync(process.execPath, [...args, "--offline"], options);
  if (!cached.error && cached.status === 0) return;
  const registry = process.env.LUBAN_NPM_REGISTRY || process.env.npm_config_registry || "https://registry.npmmirror.com/";
  console.log(`Cache incomplete; install runtime dependencies from ${registry}`);
  // Copying .npmrc also makes npm replace registry.npmjs.org lock URLs. Existing
  // npmmirror lock URLs already use the domestic mirror.
  const online = spawnSync(process.execPath, [...args, `--registry=${registry}`, "--prefer-offline", "--fetch-retries=1", "--fetch-timeout=60000"], options);
  if (online.error || online.status !== 0) throw new Error("Runtime dependencies unavailable from cache and registry. Run npm ci --include=dev with a reachable registry first, then retry release.");
}
