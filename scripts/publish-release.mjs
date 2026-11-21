/**
 * Upload finished installers to the luban release server and announce them.
 *
 * `npm run release` builds files under `release/`; this script is the step that
 * makes them reachable by `luban update`, the terminal's startup prompt and the
 * desktop's 检查更新 item. Two calls per version, matching the server:
 *
 *   PUT  /api/admin/artifact?file=<name>   bytes, verified by sha256 as they land
 *   POST /api/admin/release                the manifest clients read
 *
 * Publishing is deliberately a separate command: building and announcing are
 * different decisions, and a broken build must be discardable without touching
 * what clients already see.
 *
 *   LUBAN_RELEASES_URL    base URL of the release server (default: built-in)
 *   LUBAN_RELEASES_TOKEN  bearer token; or ~/.luban/releases-token (0600)
 *
 *   npm run publish:release -- --version 2.7.12 [--notes "…"] [--dry-run]
 *
 * Notes default to the matching CHANGELOG.md section: every published version must
 * say what changed, otherwise the update prompt ships an empty log.
 */
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { readFile, readdir, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(fileURLToPath(new URL("..", import.meta.url)));

const help = `Usage: npm run publish:release -- --version X.Y.Z [--notes "…"] [options]

  --version  release version; every artifact in --dir must carry it  (required)
  --notes    release notes shown by luban update and the update panel
             (default: this version's CHANGELOG.md section — an empty log is refused)
  --dir      directory holding the built files              (default: release/)
  --url      release server base URL        (default: LUBAN_RELEASES_URL or built-in)
  --kind     only publish these kinds, comma separated (default: every file found)
  --github   publish an existing GitHub release tag (vX.Y.Z) instead of uploading:
             rows point at the GitHub asset URLs, nothing is copied here
  --github-repo  owner/repo of that release     (default: holylong/luban)
  --dry-run  list what would be uploaded, call nothing
  --help     show this text

token: LUBAN_RELEASES_TOKEN, or the contents of ~/.luban/releases-token
`;

const PLATFORM_WORDS = { mac: "darwin", macos: "darwin", darwin: "darwin", windows: "win32", win: "win32", win32: "win32", linux: "linux", debian: "linux" };
const ARCH_WORDS = { x64: "x64", arm64: "arm64", amd64: "x64" };
/** zips/dmg from package-macos, zips from package-windows (both name the platform). */
const FILE = /^luban-(cli|desktop|creator)[-_](\d+\.\d+\.\d+)[-_](mac|macos|darwin|windows|win|win32|linux|debian)[-_](x64|arm64|amd64)\.(zip|dmg|exe|deb)$/u;
/** package-linux names the superproject only on the architecture: `…_amd64.deb`. */
const DEB = /^luban-(cli|desktop|creator)_(\d+\.\d+\.\d+)_(amd64|arm64)\.deb$/u;

/** `luban-cli-2.7.12-mac-x64.zip` -> the triple the release catalog stores. */
export function describeArtifact(name) {
  const text = String(name ?? "");
  const deb = DEB.exec(text);
  if (deb) {
    const [, kind, version, archWord] = deb;
    return { file: text, kind, version, platform: "linux", arch: ARCH_WORDS[archWord], extension: "deb" };
  }
  const match = FILE.exec(text);
  if (!match) return undefined;
  const [, kind, version, platformWord, archWord, extension] = match;
  return { file: text, kind, version, platform: PLATFORM_WORDS[platformWord], arch: ARCH_WORDS[archWord], extension };
}

/**
 * Pull one version's section out of CHANGELOG.md.
 *
 * Every published version is supposed to describe itself; when the section is
 * missing the release is refused rather than announced with an empty log.
 */
export function changelogNotes(version, text) {
  const body = String(text ?? "").replace(/\r\n/gu, "\n");
  const heading = new RegExp(`^## ${String(version).replace(/\./gu, "\\.")}(?:\\s|$).*$`, "mu");
  const start = heading.exec(body);
  if (!start) return "";
  const from = start.index + start[0].length;
  const rest = body.slice(from);
  const next = /^## /mu.exec(rest);
  return rest.slice(0, next ? next.index : rest.length)
    .replace(/^\s+|\s+$/gu, "")
    .slice(0, 8_000);
}

/** The CHANGELOG shipped next to this script. */
async function changelogText(deps) {
  if (typeof deps.changelog === "string") return deps.changelog;
  try {
    return await readFile(join(root, "CHANGELOG.md"), "utf8");
  } catch {
    return "";
  }
}

/** Parse `--flag value` pairs into a record; unknown flags are an error. */
export function parseArgs(argv) {
  const options = { dir: join(root, "release"), kinds: [], dryRun: false };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--help" || arg === "-h") return { help: true };
    if (arg === "--dry-run") { options.dryRun = true; continue; }
    const key = {
    "--version": "version", "--notes": "notes", "--dir": "dir", "--url": "url", "--kind": "kind",
    "--github": "github", "--github-repo": "githubRepo",
  }[arg];
    if (!key) throw new Error(`unknown option ${arg}`);
    const value = argv[index + 1];
    if (value === undefined || value.startsWith("--")) throw new Error(`${arg} needs a value`);
    index += 1;
    if (key === "kind") options.kinds = value.split(",").map(item => item.trim()).filter(Boolean);
    else options[key] = value;
  }
  if (!/^\d{1,3}\.\d{1,3}\.\d{1,3}$/u.test(String(options.version ?? ""))) throw new Error("--version must look like MAJOR.MINOR.PATCH");
  if (options.github !== undefined) {
    // `--github v2.7.19` names the tag; the tag has to be this version, because
    // the manifest tells every client those exact bytes are version X.
    const tag = String(options.github).trim().replace(/^v/iu, "");
    if (tag !== options.version) throw new Error(`--github tag ${options.github} does not match --version ${options.version}`);
  }
  options.dir = resolve(options.dir);
  return options;
}

/** Locate the token without ever echoing it. */
export async function readToken(env = process.env) {
  const direct = String(env.LUBAN_RELEASES_TOKEN ?? "").trim();
  if (direct) return direct;
  try {
    return (await readFile(join(homedir(), ".luban", "releases-token"), "utf8")).trim() || undefined;
  } catch {
    return undefined;
  }
}

/** Built-in release host, read from the build that this script ships with. */
export function builtinUrl() {
  const probe = spawnSync(process.execPath, ["--input-type=module", "-e",
    `import(${JSON.stringify(new URL("dist/core/service-defaults.js", `file://${root}/`).href)}).then(m => process.stdout.write(m.DEFAULT_UPDATE_URL))`],
  { encoding: "utf8" });
  return probe.status === 0 ? probe.stdout.trim() : "";
}

async function digest(path) {
  const hash = createHash("sha256");
  let size = 0;
  for await (const chunk of createReadStream(path)) {
    size += chunk.length;
    hash.update(chunk);
  }
  return { sha256: hash.digest("hex"), size };
}

/** Every built file in `dir` that belongs to this version and these kinds. */
export async function collectArtifacts(dir, version, kinds = []) {
  const names = await readdir(dir).catch(() => []);
  const found = [];
  for (const name of names.sort()) {
    const described = describeArtifact(name);
    if (!described || described.version !== version) continue;
    if (kinds.length && !kinds.includes(described.kind)) continue;
    const info = await stat(join(dir, name));
    if (!info.isFile()) continue;
    found.push({ ...described, path: join(dir, name) });
  }
  return found;
}

async function upload(url, token, artifact, { fetchImpl = fetch } = {}) {
  const { sha256, size } = await digest(artifact.path);
  const response = await fetchImpl(`${url}/api/admin/artifact?file=${encodeURIComponent(artifact.file)}`, {
    method: "PUT",
    headers: {
      authorization: `Bearer ${token}`,
      "x-luban-sha256": sha256,
      "content-type": "application/octet-stream",
      "content-length": String(size),
    },
    body: createReadStream(artifact.path),
    duplex: "half",
  });
  const text = await response.text();
  if (!response.ok) throw new Error(`upload ${artifact.file} failed: HTTP ${response.status} ${text.slice(0, 200)}`);
  return { ...artifact, sha256, size };
}

async function announce(url, token, version, notes, artifacts, { fetchImpl = fetch } = {}) {
  const response = await fetchImpl(`${url}/api/admin/release`, {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify({
      version,
      publishedAt: new Date().toISOString(),
      notes,
      artifacts: artifacts.map(({ file, sha256, size, kind, platform, arch, url: artifactUrl }) => ({
        file, sha256, size, kind, platform, arch, ...(artifactUrl ? { url: artifactUrl } : {}),
      })),
    }),
  });
  const text = await response.text();
  if (!response.ok) throw new Error(`publish failed: HTTP ${response.status} ${text.slice(0, 200)}`);
  return text ? JSON.parse(text) : {};
}

/** Public mirror every release is also published to; `--github-repo` overrides it. */
export const DEFAULT_GITHUB_REPO = "holylong/luban";

/**
 * The manifest rows for a GitHub release.
 *
 * Nothing is uploaded: the row carries an absolute download URL, the sha256
 * GitHub publishes for the asset (`digest`) and its byte size. That is what the
 * client verifies after downloading, so the release server never has to hold a
 * copy — which is also why an upgrade keeps working when the tunnel is down.
 */
export async function githubArtifacts(repo, tag, version, { githubFetch = fetch, kinds = [] } = {}) {
  const response = await githubFetch(`https://api.github.com/repos/${repo}/releases/tags/${tag}`, {
    headers: { accept: "application/vnd.github+json", "user-agent": `luban-publish/${version}` },
  });
  const text = await response.text();
  if (!response.ok) throw new Error(`GitHub release ${tag} of ${repo} failed: HTTP ${response.status} ${text.slice(0, 200)}`);
  const body = JSON.parse(text);
  const order = { dmg: 0, zip: 1, deb: 2, exe: 3 };
  const rows = [];
  for (const asset of Array.isArray(body.assets) ? body.assets : []) {
    const described = describeArtifact(asset?.name);
    if (!described || described.version !== version) continue;
    if (kinds.length && !kinds.includes(described.kind)) continue;
    const digest = typeof asset.digest === "string" ? asset.digest.trim().toLowerCase() : "";
    const sha256 = digest.startsWith("sha256:") ? digest.slice("sha256:".length) : "";
    const size = Number(asset.size);
    const artifactUrl = typeof asset.browser_download_url === "string" ? asset.browser_download_url : "";
    if (!/^[0-9a-f]{64}$/u.test(sha256) || !Number.isSafeInteger(size) || size <= 0) {
      throw new Error(`GitHub asset ${asset.name} has no sha256 digest or size; refusing to publish it`);
    }
    if (!/^https:\/\//u.test(artifactUrl)) throw new Error(`GitHub asset ${asset.name} has no download URL`);
    rows.push({ ...described, sha256, size, url: artifactUrl });
  }
  // One build per platform-arch-kind: a dmg wins over the zip fallback.
  rows.sort((left, right) => (order[left.extension] ?? 9) - (order[right.extension] ?? 9));
  const seen = new Set();
  return rows.filter(row => {
    const key = `${row.platform}-${row.arch}-${row.kind}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

export async function main(argv = process.argv.slice(2), deps = {}) {
  const options = parseArgs(argv);
  if (options.help) { process.stdout.write(help); return 0; }
  const url = String(options.url ?? deps.env?.LUBAN_RELEASES_URL ?? process.env.LUBAN_RELEASES_URL ?? deps.url ?? builtinUrl()).trim().replace(/\/+$/u, "");
  if (!url) throw new Error("no release server URL: pass --url or set LUBAN_RELEASES_URL");
  const notes = String(options.notes ?? "").trim() || changelogNotes(options.version, await changelogText(deps));
  if (!notes) {
    throw new Error(`no release notes for ${options.version}: add a "## ${options.version} — <date>" section to CHANGELOG.md (or pass --notes) — a version with an empty log is not worth publishing`);
  }
  const githubRepo = String(options.githubRepo ?? deps.env?.LUBAN_GITHUB_REPO ?? process.env.LUBAN_GITHUB_REPO ?? DEFAULT_GITHUB_REPO).trim();
  const artifacts = options.github !== undefined
    ? await githubArtifacts(githubRepo, `v${options.version}`, options.version, { ...deps, kinds: options.kinds })
    : await collectArtifacts(options.dir, options.version, options.kinds);
  if (!artifacts.length) {
    throw new Error(options.github !== undefined
      ? `GitHub release v${options.version} of ${githubRepo} has no ${options.version} packages`
      : `no ${options.version} artifacts in ${options.dir}; run npm run release first`);
  }
  const lines = artifacts.map(item => `  ${item.kind.padEnd(7)} ${item.platform}-${item.arch}  ${item.file}${item.url ? `  <- ${item.url}` : ""}`);
  if (options.dryRun) {
    process.stdout.write(`would publish ${options.version} to ${url}\n${lines.join("\n")}\n`);
    process.stdout.write(`notes (${notes.length} chars):\n${notes.split("\n").slice(0, 4).join("\n")}\n`);
    return 0;
  }
  // A caller that names `token` — even as undefined — is deciding for itself, so
  // the on-disk token file must not leak into that decision (tests rely on it).
  const token = "token" in deps ? deps.token : await readToken(deps.env ?? process.env);
  if (!token) throw new Error("no release token: set LUBAN_RELEASES_TOKEN or write ~/.luban/releases-token");
  process.stdout.write(`publishing ${options.version} to ${url}\n`);
  // Mirroring a GitHub release uploads nothing: the bytes already live there.
  const uploaded = options.github !== undefined
    ? artifacts
    : [];
  for (const artifact of options.github === undefined ? artifacts : []) {
    process.stdout.write(`  uploading ${artifact.file} … `);
    uploaded.push(await upload(url, token, artifact, deps));
    process.stdout.write("ok\n");
  }
  const reply = await announce(url, token, options.version, notes, uploaded, deps);
  process.stdout.write(`published ${reply.version ?? options.version}: ${reply.artifacts ?? uploaded.length} artifacts\n${lines.join("\n")}\n`);
  process.stdout.write(`check it with: LUBAN_UPDATES_URL=${url} luban update --json\n`);
  return 0;
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) {
  main().then(code => process.exit(code)).catch(error => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exit(1);
  });
}
