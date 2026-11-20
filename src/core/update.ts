/* Version checking and self-installation for every luban front end.
 *
 * One release server answers one question — "for my platform, is there
 * something newer, and what do I download?" — and this module is the only place
 * that asks it. The terminal, the local web UI, the desktop app and Creator all
 * go through `checkForUpdate` / `downloadUpdate` / `installUpdate`, so a user
 * who turns checking off (or skips one version) sees that decision honoured
 * everywhere instead of in one surface out of four.
 *
 * Installing is deliberately split in two steps. Downloading a file is safe;
 * replacing the folder a running process was started from is not, so the swap
 * happens in a detached shell script that waits for the current process to exit
 * first. Nothing here writes outside `<home>/updates` until that script runs.
 */
import { createHash } from "node:crypto";
import { spawn, spawnSync } from "node:child_process";
import { chmodSync, createWriteStream, existsSync, readdirSync, realpathSync, rmSync, statSync } from "node:fs";
import { mkdir, rename, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { DEFAULT_UPDATE_URL } from "./service-defaults.js";

/** Which product is asking. All three ship separately but share this code. */
export type UpdateKind = "cli" | "desktop" | "creator";

export interface UpdateArtifact {
  version: string;
  publishedAt: string;
  notes: string;
  file: string;
  /**
   * Where the bytes are: a path on the release host (`/downloads/<file>`) or an
   * absolute `https://…` URL. The GitHub Releases mirror publishes absolute
   * URLs so an upgrade does not depend on the release server staying reachable.
   */
  url: string;
  sha256: string;
  size: number;
  kind: UpdateKind;
  platform: string;
  arch: string;
}

export type UpdateStatus =
  /** A newer build for this platform exists. */
  | "available"
  /** Running the newest build (or a newer one, e.g. a local build). */
  | "current"
  /** The server knows a newer version but ships nothing for this triple. */
  | "no-build"
  /** The user asked not to be reminded about exactly this version. */
  | "skipped"
  /** Checking is turned off in config. */
  | "disabled"
  /** The server could not be reached or answered nonsense. */
  | "unreachable";

export interface UpdateCheck {
  status: UpdateStatus;
  current: string;
  /** Newest version the server knows, whatever it ships. */
  latest?: string;
  /** The build for this platform, when there is one. */
  artifact?: UpdateArtifact;
  /** Why the check did not produce a version, for `--json` and notices. */
  reason?: string;
  /** Which host answered: the release server, or the GitHub mirror behind it. */
  source?: "server" | "github";
}

export interface CheckOptions {
  currentVersion: string;
  kind?: UpdateKind;
  /** Base URL of the release server; empty uses the built-in default. */
  url?: string;
  /** Version the user asked not to be reminded about. */
  skippedVersion?: string;
  platform?: string;
  arch?: string;
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
  /** `owner/repo` of the GitHub mirror; defaults to the public project. */
  githubRepo?: string;
}

const VERSION = /^(\d{1,4})\.(\d{1,4})\.(\d{1,4})$/u;

/** `2.7.12` -> `[2, 7, 12]`; anything else is `undefined`. */
export function parseVersionText(value: string): [number, number, number] | undefined {
  const match = VERSION.exec(String(value ?? "").trim());
  return match ? [Number(match[1]), Number(match[2]), Number(match[3])] : undefined;
}

/**
 * Numeric comparison of two `MAJOR.MINOR.PATCH` versions.
 *
 * Not semver on purpose: luban's versions are plain triples and a `-rc1` suffix
 * must not sort above the release it precedes. Unparseable input sorts lowest.
 */
export function compareVersions(left: string, right: string): number {
  const a = parseVersionText(left) ?? [0, 0, 0];
  const b = parseVersionText(right) ?? [0, 0, 0];
  for (let index = 0; index < 3; index += 1) {
    if (a[index] !== b[index]) return a[index]! < b[index]! ? -1 : 1;
  }
  return 0;
}

export function isNewer(candidate: string, current: string): boolean {
  return compareVersions(candidate, current) > 0;
}

/** `<host>` or `<host>/api/update` both work; a trailing slash is trimmed. */
export function releaseEndpoint(base: string): string {
  const trimmed = (base || DEFAULT_UPDATE_URL).trim().replace(/\/+$/u, "");
  return /\/api\/update$/u.test(trimmed) ? trimmed : `${trimmed}/api/update`;
}

/**
 * Absolute download URL for an artifact advertised by the manifest.
 *
 * A manifest may advertise either a path on the release host or an absolute
 * URL (the GitHub mirror does the latter); an absolute URL is used verbatim so
 * the package really is fetched from the host the publisher named.
 */
export function artifactUrl(base: string, artifact: Pick<UpdateArtifact, "url">): string {
  if (/^https?:\/\//iu.test(artifact.url)) return artifact.url;
  const root = (base || DEFAULT_UPDATE_URL).trim().replace(/\/+$/u, "").replace(/\/api\/update$/u, "");
  return `${root}${artifact.url.startsWith("/") ? "" : "/"}${artifact.url}`;
}

/**
 * Which product is running.
 *
 * Electron sets `LUBAN_UPDATE_KIND` before it hands control to this module; a
 * plain terminal run is the CLI bundle.
 */
export function currentKind(env: NodeJS.ProcessEnv = process.env): UpdateKind {
  const declared = String(env.LUBAN_UPDATE_KIND ?? "").trim().toLowerCase();
  return declared === "desktop" || declared === "creator" ? declared : "cli";
}

/**
 * May a client contact the release server on its own?
 *
 * `LUBAN_NO_UPDATE_CHECK=1` is the hard off switch (CI, air-gapped machines),
 * and the test runner stays quiet unless a test opts in — otherwise every TUI
 * test would fire a real request and wait on its timeout.
 */
export function startupCheckAllowed(env: NodeJS.ProcessEnv = process.env): boolean {
  if (env.LUBAN_NO_UPDATE_CHECK === "1") return false;
  if (env.VITEST && env.LUBAN_UPDATE_CHECK !== "1") return false;
  return true;
}

/**
 * Ask the release server. Never throws: every failure is a status the caller
 * can show or ignore, because a version check must never block a startup.
 */
export async function checkForUpdate(options: CheckOptions): Promise<UpdateCheck> {
  const primary = await checkReleaseServer(options);
  if (primary.status !== "unreachable") return { ...primary, source: "server" };
  // The release server is a Cloudflare quick tunnel, and those hostnames rotate
  // (and are blocked outright on some networks). Every release is also published
  // to GitHub, so a dead manifest host must not turn every upgrade into "手动下".
  const mirror = await checkGithubReleases(options);
  if (!mirror) return primary;
  return { ...mirror, source: "github", reason: mirror.reason ?? primary.reason };
}

async function checkReleaseServer(options: CheckOptions): Promise<UpdateCheck> {
  const current = options.currentVersion;
  if (!current) return { status: "unreachable", current, reason: "unknown local version" };
  const fetchImpl = options.fetchImpl ?? fetch;
  const platform = options.platform ?? process.platform;
  const arch = options.arch ?? process.arch;
  const kind = options.kind ?? currentKind();
  const query = new URLSearchParams({ platform, arch, kind });
  const endpoint = `${releaseEndpoint(options.url ?? "")}?${query.toString()}`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), Math.max(1_000, options.timeoutMs ?? 8_000));
  let body: unknown;
  try {
    const response = await fetchImpl(endpoint, {
      headers: { accept: "application/json", "user-agent": `luban/${current}` },
      signal: controller.signal,
    });
    if (!response.ok) {
      return { status: "unreachable", current, reason: `release server answered ${response.status}` };
    }
    body = await response.json();
  } catch (error) {
    const reason = error instanceof Error && error.name === "AbortError" ? "release server timed out" : "release server unreachable";
    return { status: "unreachable", current, reason };
  } finally {
    clearTimeout(timer);
  }

  const record = (body ?? {}) as Record<string, unknown>;
  if (record.ok !== true) return { status: "unreachable", current, reason: "release server answered without ok" };
  const latestRecord = (record.latest ?? null) as Record<string, unknown> | null;
  const latest = latestRecord && typeof latestRecord.version === "string" ? latestRecord.version : undefined;
  const artifact = readArtifact(record.artifact);
  if (artifact && options.skippedVersion && artifact.version === options.skippedVersion && isNewer(artifact.version, current)) {
    return { status: "skipped", current, latest: latest ?? artifact.version, artifact };
  }
  if (artifact && isNewer(artifact.version, current)) {
    return { status: "available", current, latest: latest ?? artifact.version, artifact };
  }
  // The server may be a release ahead without shipping this platform; saying so
  // is more useful than claiming "up to date" while `/releases` shows newer.
  if (latest && isNewer(latest, current)) {
    return { status: "no-build", current, latest, reason: `no ${kind} build for ${platform}-${arch} in ${latest}` };
  }
  return { status: "current", current, latest, ...(artifact ? { artifact } : {}) };
}

/** Public mirror of every release; `LUBAN_GITHUB_REPO` overrides it for forks. */
export const DEFAULT_GITHUB_REPO = "holylong/luban";

/**
 * File names a GitHub release is expected to carry for one triple.
 *
 * Mirrors `scripts/package-*.mjs`: macOS CLI is a zip and the GUI is a dmg
 * (zip when hdiutil failed), Windows is a portable zip, Linux is a .deb.
 */
export function githubAssetNames(kind: UpdateKind, platform: string, arch: string, version: string): string[] {
  if (platform === "darwin") {
    return kind === "cli"
      ? [`luban-cli-${version}-mac-${arch}.zip`]
      : [`luban-${kind}-${version}-mac-${arch}.dmg`, `luban-${kind}-${version}-mac-${arch}.zip`];
  }
  if (platform === "win32") return [`luban-${kind}-${version}-win-${arch}.zip`];
  if (platform === "linux") return [`luban-${kind}_${version}_${arch === "x64" ? "amd64" : arch}.deb`];
  return [];
}

/**
 * Ask GitHub for the newest release instead of the release server.
 *
 * `undefined` means "the mirror could not answer" so the caller keeps the
 * original server failure; a release without a build for this triple is
 * reported as `no-build`, not as an error.
 */
async function checkGithubReleases(options: CheckOptions): Promise<UpdateCheck | undefined> {
  const current = options.currentVersion;
  const fetchImpl = options.fetchImpl ?? fetch;
  const platform = options.platform ?? process.platform;
  const arch = options.arch ?? process.arch;
  const kind = options.kind ?? currentKind();
  const repo = (options.githubRepo ?? process.env.LUBAN_GITHUB_REPO ?? DEFAULT_GITHUB_REPO).trim();
  if (!repo) return undefined;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), Math.max(1_000, options.timeoutMs ?? 8_000));
  let body: unknown;
  try {
    const response = await fetchImpl(`https://api.github.com/repos/${repo}/releases/latest`, {
      headers: { accept: "application/vnd.github+json", "user-agent": `luban/${current}` },
      signal: controller.signal,
    });
    if (!response.ok) return undefined;
    body = await response.json();
  } catch {
    return undefined;
  } finally {
    clearTimeout(timer);
  }

  const record = (body ?? {}) as Record<string, unknown>;
  const tag = typeof record.tag_name === "string" ? record.tag_name.trim().replace(/^v/iu, "") : "";
  const version = parseVersionText(tag) ? tag : "";
  if (!version) return undefined;
  const assets = Array.isArray(record.assets) ? (record.assets as Record<string, unknown>[]) : [];
  const artifact = readGithubArtifact(assets, { kind, platform, arch, version, notes: record.body, publishedAt: record.published_at });
  if (!artifact) {
    return isNewer(version, current)
      ? { status: "no-build", current, latest: version, reason: `no ${kind} build for ${platform}-${arch} in ${version}` }
      : { status: "current", current, latest: version };
  }
  if (options.skippedVersion && artifact.version === options.skippedVersion && isNewer(artifact.version, current)) {
    return { status: "skipped", current, latest: version, artifact };
  }
  if (isNewer(artifact.version, current)) return { status: "available", current, latest: version, artifact };
  return { status: "current", current, latest: version, artifact };
}

/**
 * The matching asset, with the digest GitHub publishes for it.
 *
 * An asset without a sha256 digest is skipped: the downloader proves the bytes
 * against that digest, so an unverified mirror entry is worse than no upgrade.
 */
function readGithubArtifact(
  assets: Record<string, unknown>[],
  want: { kind: UpdateKind; platform: string; arch: string; version: string; notes: unknown; publishedAt: unknown },
): UpdateArtifact | undefined {
  const wanted = githubAssetNames(want.kind, want.platform, want.arch, want.version);
  for (const name of wanted) {
    const row = assets.find(asset => asset && asset.name === name);
    if (!row) continue;
    const url = typeof row.browser_download_url === "string" ? row.browser_download_url : "";
    const digest = typeof row.digest === "string" ? row.digest.trim().toLowerCase() : "";
    const sha256 = digest.startsWith("sha256:") ? digest.slice("sha256:".length) : "";
    const size = Number(row.size);
    if (!/^https:\/\//iu.test(url) || !/^[0-9a-f]{64}$/u.test(sha256) || !Number.isSafeInteger(size) || size <= 0) continue;
    return {
      version: want.version,
      publishedAt: typeof want.publishedAt === "string" ? want.publishedAt : "",
      notes: typeof want.notes === "string" ? want.notes.slice(0, 8_000) : "",
      file: name,
      url,
      sha256,
      size,
      kind: want.kind,
      platform: want.platform,
      arch: want.arch,
    };
  }
  return undefined;
}

function readArtifact(value: unknown): UpdateArtifact | undefined {
  if (!value || typeof value !== "object") return undefined;
  const row = value as Record<string, unknown>;
  const version = typeof row.version === "string" ? row.version : "";
  const file = typeof row.file === "string" ? row.file : "";
  const url = typeof row.url === "string" ? row.url : file ? `/downloads/${file}` : "";
  const sha256 = typeof row.sha256 === "string" ? row.sha256.toLowerCase() : "";
  const size = Number(row.size);
  if (!parseVersionText(version) || !file || !url || !/^[0-9a-f]{64}$/u.test(sha256) || !Number.isFinite(size) || size <= 0) return undefined;
  return {
    version,
    publishedAt: typeof row.publishedAt === "string" ? row.publishedAt : "",
    notes: typeof row.notes === "string" ? row.notes : "",
    file,
    url,
    sha256,
    size,
    kind: (row.kind === "desktop" || row.kind === "creator" ? row.kind : "cli") as UpdateKind,
    platform: typeof row.platform === "string" ? row.platform : "",
    arch: typeof row.arch === "string" ? row.arch : "",
  };
}

export interface DownloadOptions {
  /** Base URL the artifact was advertised from. */
  baseUrl?: string;
  /** Directory to keep the file in; defaults to `<home>/updates`. */
  directory?: string;
  home?: string;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
  onProgress?: (received: number, total: number) => void;
  signal?: AbortSignal;
}

export class UpdateError extends Error {
  constructor(message: string, readonly hint?: string) {
    super(message);
    this.name = "UpdateError";
  }
}

/**
 * Download one artifact and prove it is the one the server described.
 *
 * Bytes land in `<file>.part` and are renamed only after the size and sha256
 * match, so an interrupted download can never be mistaken for an installer.
 */
export async function downloadUpdate(artifact: UpdateArtifact, options: DownloadOptions = {}): Promise<string> {
  const directory = options.directory ?? join(options.home ?? resolve(process.env.LUBAN_HOME || join(homedir(), ".luban")), "updates");
  await mkdir(directory, { recursive: true, mode: 0o755 });
  const target = join(directory, basename(artifact.file));
  const partial = `${target}.part`;
  const fetchImpl = options.fetchImpl ?? fetch;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), Math.max(30_000, options.timeoutMs ?? 10 * 60_000));
  const onAbort = () => controller.abort();
  options.signal?.addEventListener("abort", onAbort);
  try {
    const response = await fetchImpl(artifactUrl(options.baseUrl ?? "", artifact), { signal: controller.signal });
    if (!response.ok || !response.body) throw new UpdateError(`下载失败（HTTP ${response.status}）`, artifactUrl(options.baseUrl ?? "", artifact));
    const hash = createHash("sha256");
    let received = 0;
    const sink = createWriteStream(partial, { mode: 0o644 });
    const reader = response.body.getReader();
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        if (!value?.length) continue;
        received += value.length;
        hash.update(value);
        if (!sink.write(value)) await new Promise<void>((resolveDrain) => sink.once("drain", () => resolveDrain()));
        options.onProgress?.(received, artifact.size);
      }
    } finally {
      await new Promise<void>((resolveClose, rejectClose) => {
        sink.end((error?: Error | null) => (error ? rejectClose(error) : resolveClose()));
      });
    }
    const digest = hash.digest("hex");
    if (received !== artifact.size) {
      throw new UpdateError(`下载不完整：${received} 字节，应为 ${artifact.size}`);
    }
    if (digest !== artifact.sha256) {
      throw new UpdateError(`校验失败：sha256 ${digest.slice(0, 12)}…，应为 ${artifact.sha256.slice(0, 12)}…`);
    }
    rmSync(target, { force: true });
    await rename(partial, target);
    return target;
  } catch (error) {
    await rm(partial, { force: true });
    if (error instanceof UpdateError) throw error;
    if (error instanceof Error && error.name === "AbortError") throw new UpdateError("下载已取消");
    throw new UpdateError(error instanceof Error ? error.message : String(error));
  } finally {
    clearTimeout(timeout);
    options.signal?.removeEventListener("abort", onAbort);
  }
}

export interface InstallResult {
  ok: boolean;
  /** Where the new build ends up. */
  target?: string;
  /** `relaunch` means a script reopens the app; `manual` means the user does. */
  restart: "relaunch" | "manual";
  reason?: string;
}

/**
 * The folder a CLI bundle was unpacked into, or `undefined` in a source
 * checkout.
 *
 * A luban-cli zip is `<root>/{luban,node,app/}`; only that layout can be
 * replaced safely. Running `dist/cli.js` from a git checkout must never try to
 * rewrite the checkout, so no root is reported there.
 */
export function cliInstallRoot(start = import.meta.url): string | undefined {
  let path: string;
  try {
    path = realpathSync(start.startsWith("file:") ? new URL(start) : start);
  } catch {
    return undefined;
  }
  let directory = statSync(path).isDirectory() ? path : dirname(path);
  for (let depth = 0; depth < 6; depth += 1) {
    const hasLauncher = existsSync(join(directory, "luban")) || existsSync(join(directory, "luban.cmd"));
    if (hasLauncher && existsSync(join(directory, "app")) && (existsSync(join(directory, "node")) || existsSync(join(directory, "node.exe")))) {
      return directory;
    }
    const parent = dirname(directory);
    if (parent === directory) break;
    directory = parent;
  }
  return undefined;
}

/** The running `.app` bundle on macOS, when there is one. */
export function appBundlePath(env: NodeJS.ProcessEnv = process.env, execPath = process.execPath): string | undefined {
  if (env.LUBAN_APP_BUNDLE) return env.LUBAN_APP_BUNDLE;
  if (process.platform !== "darwin") return undefined;
  const marker = execPath.indexOf(".app/");
  return marker > 0 ? execPath.slice(0, marker + 4) : undefined;
}

/** macOS bundle name per product; also the default `/Applications` target. */
const BUNDLE_NAME: Record<"desktop" | "creator", string> = { desktop: "luban.app", creator: "Creator.app" };

function quote(value: string): string {
  if (value.includes("'")) throw new UpdateError(`路径里含有单引号，无法自动替换：${value}`);
  return `'${value}'`;
}

/**
 * Replace paths after this process exits.
 *
 * The script is written to a temp file and started detached, so quitting luban
 * does not kill the one process that is still finishing the upgrade. It waits
 * on the caller's PID rather than sleeping a guessed amount of time.
 */
export async function deferredReplace(
  steps: { from: string; to: string }[],
  options: { waitForPid?: number; reopen?: string; home?: string } = {},
): Promise<string> {
  const pid = options.waitForPid ?? process.pid;
  const directory = join(options.home ?? resolve(process.env.LUBAN_HOME || join(homedir(), ".luban")), "updates");
  await mkdir(directory, { recursive: true, mode: 0o755 });
  const script = join(directory, `install-${Date.now()}.sh`);
  const lines = [
    "#!/bin/sh",
    "# Written by luban: swap in a downloaded build once the old process is gone.",
    `for _ in $(seq 1 600); do kill -0 ${pid} 2>/dev/null || break; sleep 0.1; done`,
    "sleep 0.2",
  ];
  for (const step of steps) {
    lines.push(`rm -rf ${quote(`${step.to}.old`)}`);
    lines.push(`if [ -e ${quote(step.to)} ]; then mv ${quote(step.to)} ${quote(`${step.to}.old`)}; fi`);
    lines.push(`mv ${quote(step.from)} ${quote(step.to)}`);
    lines.push(`rm -rf ${quote(`${step.to}.old`)}`);
  }
  if (options.reopen) lines.push(`open ${quote(options.reopen)} >/dev/null 2>&1 &`);
  lines.push(`rm -f ${quote(script)}`);
  await writeFile(script, `${lines.join("\n")}\n`, { mode: 0o755 });
  chmodSync(script, 0o755);
  const child = spawn("/bin/sh", [script], { detached: true, stdio: "ignore" });
  child.unref();
  return script;
}

function run(command: string, args: string[], cwd?: string): { ok: boolean; output: string } {
  const result = spawnSync(command, args, { cwd, encoding: "utf8", timeout: 10 * 60_000 });
  const output = `${result.stdout ?? ""}${result.stderr ?? ""}`.trim();
  return { ok: result.status === 0, output };
}

/**
 * Install a downloaded build.
 *
 * CLI bundles are unzipped next to their current folder and swapped in after
 * exit. Desktop and Creator ship as a dmg: mount, copy the bundle beside the
 * running one, unmount, swap, reopen.
 */
export async function installUpdate(
  artifact: UpdateArtifact,
  archivePath: string,
  options: { waitForPid?: number; home?: string; kind?: UpdateKind; root?: string } = {},
): Promise<InstallResult> {
  const kind = options.kind ?? artifact.kind ?? currentKind();
  if (kind === "cli") return installCliBundle(archivePath, options);
  return installMacApp(kind as "desktop" | "creator", archivePath, options);
}

async function installCliBundle(archivePath: string, options: { waitForPid?: number; home?: string; root?: string }): Promise<InstallResult> {
  const root = options.root ?? cliInstallRoot();
  if (!root) {
    throw new UpdateError("这个 luban 是从源码目录运行的，没法自动替换", `请手动解压 ${archivePath}，或重新构建`);
  }
  if (!existsSync("/usr/bin/unzip") && !run("unzip", ["-v"]).ok) {
    throw new UpdateError("系统里没有 unzip，无法解压升级包", `请手动解压 ${archivePath}`);
  }
  const staging = `${root}.next-${Date.now()}`;
  rmSync(staging, { recursive: true, force: true });
  await mkdir(staging, { recursive: true, mode: 0o755 });
  const unzipped = run("unzip", ["-q", archivePath, "-d", staging]);
  if (!unzipped.ok) {
    rmSync(staging, { recursive: true, force: true });
    throw new UpdateError(`解压失败：${unzipped.output || "unzip 报错"}`);
  }
  // The archive contains one top-level folder named after the build.
  const entries = readdirSync(staging).filter((name) => !name.startsWith("__"));
  const payload = entries.length === 1 ? join(staging, entries[0]!) : staging;
  if (!existsSync(join(payload, "luban")) && !existsSync(join(payload, "luban.cmd"))) {
    rmSync(staging, { recursive: true, force: true });
    throw new UpdateError("升级包里没有 luban 启动脚本，已放弃安装");
  }
  await deferredReplace([{ from: payload, to: root }], { waitForPid: options.waitForPid, home: options.home });
  return { ok: true, target: root, restart: "manual" };
}

async function installMacApp(kind: "desktop" | "creator", dmgPath: string, options: { waitForPid?: number; home?: string }): Promise<InstallResult> {
  if (process.platform !== "darwin") {
    throw new UpdateError("桌面版安装包是 macOS 的 dmg，当前系统无法自动安装", `安装包已下载到 ${dmgPath}`);
  }
  const bundle = BUNDLE_NAME[kind];
  const running = appBundlePath();
  const target = running && basename(running) === bundle ? running : join("/Applications", bundle);
  const mount = join(dirname(dmgPath), `mount-${Date.now()}`);
  await mkdir(mount, { recursive: true, mode: 0o755 });
  const attached = run("hdiutil", ["attach", "-nobrowse", "-readonly", "-mountpoint", mount, dmgPath]);
  if (!attached.ok) {
    rmSync(mount, { recursive: true, force: true });
    throw new UpdateError(`挂载 dmg 失败：${attached.output || "hdiutil 报错"}`);
  }
  const staging = `${target}.new-${Date.now()}`;
  try {
    const source = join(mount, bundle);
    if (!existsSync(source)) throw new UpdateError(`dmg 里没有 ${bundle}`);
    rmSync(staging, { recursive: true, force: true });
    const copied = run("ditto", [source, staging]);
    if (!copied.ok) throw new UpdateError(`复制应用失败：${copied.output || "ditto 报错"}`);
    run("xattr", ["-dr", "com.apple.quarantine", staging]);
  } finally {
    run("hdiutil", ["detach", mount, "-quiet"]);
    rmSync(mount, { recursive: true, force: true });
  }
  await deferredReplace([{ from: staging, to: target }], { waitForPid: options.waitForPid, home: options.home, reopen: target });
  return { ok: true, target, restart: "relaunch" };
}
