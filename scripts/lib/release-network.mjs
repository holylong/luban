import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { homedir } from "node:os";

export function releaseEnvironment(env = process.env) {
  return { ...env,
    ELECTRON_MIRROR: env.ELECTRON_MIRROR || env.npm_config_electron_mirror || "https://npmmirror.com/mirrors/electron/",
  };
}

/**
 * Where @electron/get keeps downloaded archives when nothing overrides it.
 * It keys a directory by the download URL, so the same zip fetched from two
 * mirrors lives in two places and a slow mirror looks like a missing runtime.
 */
export function electronCacheRoot(env = process.env) {
  if (env.ELECTRON_CACHE) return env.ELECTRON_CACHE;
  if (env.electron_config_cache) return env.electron_config_cache;
  if (process.platform === "darwin") return join(homedir(), "Library", "Caches", "electron");
  if (process.platform === "win32") return join(env.LOCALAPPDATA || join(homedir(), "AppData", "Local"), "electron", "Cache");
  return join(env.XDG_CACHE_HOME || join(homedir(), ".cache"), "electron");
}

/** @param {string} version @param {string} [platform] @param {string} [arch] */
export function electronArchiveName(version, platform = process.platform, arch = process.arch) {
  return `electron-v${version}-${platform}-${arch}.zip`;
}

/** @param {string} path */
function sha256(path) {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

/**
 * An archive for this host that some earlier download already left behind.
 * @param {string} cacheRoot @param {string} name @param {string} [checksum]
 * @returns {string|null} path to the archive
 */
export function findVerifiedArchive(cacheRoot, name, checksum) {
  let entries;
  try {
    entries = readdirSync(cacheRoot, { withFileTypes: true });
  } catch {
    return null;
  }
  // Directory order is filesystem-defined; a stable pick keeps retries identical.
  for (const entry of [...entries].sort((left, right) => left.name.localeCompare(right.name))) {
    if (!entry.isDirectory()) continue;
    const candidate = join(cacheRoot, entry.name, name);
    if (!existsSync(candidate)) continue;
    if (!checksum) return candidate;
    try {
      if (sha256(candidate) === checksum) return candidate;
    } catch {
      // Unreadable archive: keep looking.
    }
  }
  return null;
}

/**
 * The verified archive for this host version, or null when none is cached.
 * @param {string} root
 * @param {NodeJS.ProcessEnv} [env]
 */
export function cachedElectronArchive(root, env = process.env) {
  const electronDir = join(root, "node_modules", "electron");
  let version;
  try {
    version = JSON.parse(readFileSync(join(electronDir, "package.json"), "utf8")).version;
  } catch {
    return null;
  }
  const name = electronArchiveName(version);
  /** @type {Record<string, string> | null} */
  let checksums = null;
  try {
    checksums = JSON.parse(readFileSync(join(electronDir, "checksums.json"), "utf8"));
  } catch {
    // Older Electron packages ship no checksums; install.js verifies the zip itself.
  }
  return { name, archive: findVerifiedArchive(electronCacheRoot(env), name, checksums?.[name]) };
}

/** @param {string} platform */
function platformPath(platform) {
  if (platform === "mas" || platform === "darwin") return "Electron.app/Contents/MacOS/Electron";
  if (platform === "win32") return "electron.exe";
  return "electron";
}

/**
 * Unpack a cached archive exactly as `electron/install.js` would, so the
 * installer finds a working `dist/` and stops asking the network.
 * @param {string} root @param {string} archive
 * @returns {Promise<boolean>}
 */
export async function seedElectronDist(root, archive) {
  const electronDir = join(root, "node_modules", "electron");
  const dist = join(electronDir, "dist");
  try {
    const { extract } = createRequire(join(electronDir, "install.js"))("@electron-internal/extract-zip");
    rmSync(dist, { recursive: true, force: true });
    await extract(archive, { dir: dist });
    const typeDefinitions = join(dist, "electron.d.ts");
    if (existsSync(typeDefinitions)) renameSync(typeDefinitions, join(electronDir, "electron.d.ts"));
    writeFileSync(join(electronDir, "path.txt"), platformPath(process.platform));
    return existsSync(join(dist, "version"));
  } catch {
    return false;
  }
}

/**
 * Make `node_modules/electron/dist` usable before a desktop package is built.
 *
 * The mirror download is the only network step a release cannot skip, and a
 * mirror that is merely slow used to fail the whole release even though a
 * verified archive from an earlier run was sitting in the cache under another
 * URL's directory. So: try the configured mirror, then seed from any cached
 * archive, then try the official host.
 *
 * @param {string} root
 * @param {{ env?: NodeJS.ProcessEnv, timeout?: number }} [options]
 */
export async function ensureElectron(root, options = {}) {
  const env = { ...releaseEnvironment(options.env) };
  const attempt = (attemptEnv) => spawnSync(process.execPath, [join(root, "node_modules", "electron", "install.js")], {
    cwd: root, env: attemptEnv, stdio: ["ignore", "inherit", "inherit"], timeout: options.timeout ?? 180000,
  });
  const ran = (result) => !result.error && result.status === 0;

  const mirrored = attempt(env);
  if (ran(mirrored)) return;

  const cached = cachedElectronArchive(root, options.env);
  if (cached?.archive && await seedElectronDist(root, cached.archive)) {
    const seeded = attempt(env);
    if (ran(seeded)) return;
  }

  const { ELECTRON_MIRROR: _mirror, npm_config_electron_mirror: _npmMirror, ...official } = env;
  const last = attempt(official);
  if (ran(last)) return;

  const where = cachedElectronArchive(root, options.env);
  const hint = where?.archive ? `cached archive ${where.archive} could not be used` : `no ${where?.name ?? "archive"} in ${electronCacheRoot(options.env)}`;
  throw new Error(`Electron runtime unavailable (${hint}). Set ELECTRON_MIRROR to a reachable mirror, or run npm run release -- --kind cli to build a ZIP without Electron.`);
}

/** @param {string} root @param {string} app @param {string} npmCli */
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
