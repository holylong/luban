/* Plugin registry: browse skill packs and install them.
 *
 * luban's portable extension point is the skill: a folder holding SKILL.md that
 * `list_skills` / `read_skill` already discover under `<home>/skills`. A plugin
 * is therefore a named bundle of those files plus the metadata a storefront
 * needs. Nothing in a plugin executes — it is markdown the model reads on
 * demand, so installing one cannot change what luban is allowed to do.
 *
 * The catalog is a single JSON document on a static host (GitHub raw today).
 * Every file carries its own sha256, so installing is "download these few
 * files, verify, write": a catalog that was edited in transit, or an entry
 * pointing at a URL whose bytes changed after review, fails closed instead of
 * landing on disk. Files are written into `<home>/skills`, exactly where skill
 * discovery already looks, and `<home>/plugins.json` records which skill
 * folders a plugin owns so uninstall removes those and nothing else.
 */
import { createHash, randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

/** Static catalog the desktop app searches when nothing else is configured. */
export const DEFAULT_PLUGIN_REGISTRY = "https://raw.githubusercontent.com/holylong/luban-plugins/main/plugins.json";

/** Install ledger under `<home>`; skill directories are the installed payload. */
export const PLUGIN_LEDGER = "plugins.json";

/** One file of a plugin: where it comes from and what it must hash to. */
export interface PluginFile {
  /** Path inside the plugin, always `skills/<skill>/…`. */
  path: string;
  /** Absolute https URL of the bytes. */
  url: string;
  /** Lowercase hex sha256 of the exact bytes at `url`. */
  sha256: string;
  /** Optional advertised size, used only to fail early. */
  bytes?: number;
}

export interface PluginEntry {
  id: string;
  name: string;
  version: string;
  description: string;
  author?: string;
  homepage?: string;
  license?: string;
  tags?: string[];
  /** Skill names the entry advertises; derived from `files` when absent. */
  skills?: string[];
  files: PluginFile[];
}

export interface PluginCatalog {
  schemaVersion: 1;
  /** ISO time the maintainer regenerated the catalog. */
  updatedAt?: string;
  plugins: PluginEntry[];
}

/** What one successful install left on disk. */
export interface InstalledPlugin {
  id: string;
  version: string;
  installedAt: string;
  /** Skill folder names this plugin owns inside `<home>/skills`. */
  skills: string[];
  /** Manifest path -> sha256 that was verified, for later auditing. */
  files: Record<string, string>;
}

export type Installations = Record<string, InstalledPlugin>;

/** Wiring for tests and for the server's per-request fetch/signal. */
export interface PluginIO {
  fetchImpl?: typeof fetch;
  signal?: AbortSignal;
  timeoutMs?: number;
  now?: () => Date;
}

export class PluginError extends Error {}

const SKILL_ROOT = "skills";
const MAX_FILE_BYTES = 512 * 1024;
const MAX_PLUGIN_FILES = 64;
const ID = /^[a-z0-9][a-z0-9._-]{0,63}$/u;
const SHA256 = /^[0-9a-f]{64}$/u;

const skillsDir = (home: string): string => join(home, "skills");
const ledgerPath = (home: string): string => join(home, PLUGIN_LEDGER);

const asString = (value: unknown, field: string): string => {
  if (typeof value !== "string" || !value.trim()) throw new PluginError(`插件目录缺少 ${field}`);
  return value.trim();
};

const asOptionalString = (value: unknown): string | undefined =>
  typeof value === "string" && value.trim() ? value.trim() : undefined;

/**
 * The skill a manifest path belongs to, or a rejection.
 *
 * Every file has to live under `skills/<skill>/…`: a catalog entry cannot
 * write outside the skills root, cannot reach a parent directory, and cannot
 * use a Windows drive or an absolute path to escape.
 */
export function skillOfPath(path: string): string {
  const normalized = path.replace(/\\/gu, "/").trim();
  if (!normalized || normalized.includes("\0")) throw new PluginError("插件文件路径为空");
  if (normalized.startsWith("/") || /^[A-Za-z]:/u.test(normalized)) throw new PluginError(`插件文件路径必须是相对路径：${path}`);
  const parts = normalized.split("/");
  if (parts.some(part => !part || part === "." || part === "..")) throw new PluginError(`插件文件路径不安全：${path}`);
  const [root, skill, ...rest] = parts;
  if (root !== SKILL_ROOT || !skill || rest.length === 0) throw new PluginError(`插件文件必须放在 skills/<技能名>/ 下：${path}`);
  if (!ID.test(skill)) throw new PluginError(`技能名只能是小写字母、数字、点、下划线和短横线：${skill}`);
  return skill;
}

function normalizeFile(raw: unknown, index: number): PluginFile {
  const source = raw && typeof raw === "object" ? raw as Record<string, unknown> : {};
  const path = asString(source.path, `files[${index}].path`);
  skillOfPath(path);
  const url = asString(source.url, `files[${index}].url`);
  let parsed: URL;
  try { parsed = new URL(url); }
  catch { throw new PluginError(`插件文件 ${path} 的下载地址不是有效 URL`); }
  const loopback = ["localhost", "127.0.0.1", "[::1]"].includes(parsed.hostname);
  if (parsed.protocol !== "https:" && !(parsed.protocol === "http:" && loopback)) {
    throw new PluginError(`插件文件 ${path} 必须用 https 下载`);
  }
  const sha256 = asString(source.sha256, `files[${index}].sha256`).toLowerCase();
  if (!SHA256.test(sha256)) throw new PluginError(`插件文件 ${path} 的 sha256 无效`);
  const bytes = typeof source.bytes === "number" && Number.isFinite(source.bytes) && source.bytes >= 0 ? source.bytes : undefined;
  if (bytes !== undefined && bytes > MAX_FILE_BYTES) throw new PluginError(`插件文件 ${path} 超过 ${MAX_FILE_BYTES} 字节上限`);
  return { path: path.replace(/\\/gu, "/"), url, sha256, bytes };
}

function normalizeEntry(raw: unknown): PluginEntry {
  const source = raw && typeof raw === "object" ? raw as Record<string, unknown> : {};
  const id = asString(source.id, "id");
  if (!ID.test(id)) throw new PluginError(`插件 id 只能是小写字母、数字、点、下划线和短横线：${id}`);
  const files = Array.isArray(source.files) ? source.files.map(normalizeFile) : [];
  if (!files.length) throw new PluginError(`插件 ${id} 没有文件`);
  if (files.length > MAX_PLUGIN_FILES) throw new PluginError(`插件 ${id} 的文件数超过 ${MAX_PLUGIN_FILES}`);
  const paths = new Set<string>();
  for (const file of files) {
    if (paths.has(file.path)) throw new PluginError(`插件 ${id} 重复声明了 ${file.path}`);
    paths.add(file.path);
  }
  const tags = Array.isArray(source.tags) ? source.tags.filter((tag): tag is string => typeof tag === "string" && Boolean(tag.trim())).map(tag => tag.trim()) : undefined;
  const declared = Array.isArray(source.skills) ? source.skills.filter((name): name is string => typeof name === "string" && Boolean(name.trim())).map(name => name.trim()) : undefined;
  return {
    id,
    name: asString(source.name, `${id}.name`),
    version: asString(source.version, `${id}.version`),
    description: asString(source.description, `${id}.description`),
    author: asOptionalString(source.author),
    homepage: asOptionalString(source.homepage),
    license: asOptionalString(source.license),
    tags,
    skills: declared?.length ? declared : entrySkills({ files }),
    files,
  };
}

/** Skill folder names a manifest writes. */
export function entrySkills(entry: Pick<PluginEntry, "files">): string[] {
  return [...new Set(entry.files.map(file => skillOfPath(file.path)))].sort();
}

/**
 * Validate a catalog document.
 *
 * A malformed entry rejects the whole catalog: half a storefront is worse than
 * a clear "目录格式不对", and the caller shows the URL that answered.
 */
export function parseCatalog(raw: unknown): PluginCatalog {
  if (!raw || typeof raw !== "object") throw new PluginError("插件目录必须是 JSON 对象");
  const source = raw as Record<string, unknown>;
  if (Number(source.schemaVersion) !== 1) throw new PluginError("插件目录 schemaVersion 必须是 1");
  if (!Array.isArray(source.plugins)) throw new PluginError("插件目录缺少 plugins 数组");
  const seen = new Set<string>();
  const plugins = source.plugins.map(normalizeEntry);
  for (const plugin of plugins) {
    if (seen.has(plugin.id)) throw new PluginError(`插件目录里 id 重复：${plugin.id}`);
    seen.add(plugin.id);
  }
  return { schemaVersion: 1, updatedAt: asOptionalString(source.updatedAt), plugins };
}

/**
 * Filter the catalog the way a search box should: every whitespace-separated
 * token has to appear in the id, name, description, tags or skill names, so
 * "git 中文" narrows instead of widening.
 */
export function searchPlugins(catalog: PluginCatalog, query: string): PluginEntry[] {
  const tokens = query.toLowerCase().split(/\s+/u).filter(Boolean);
  if (!tokens.length) return [...catalog.plugins].sort((a, b) => a.name.localeCompare(b.name, "zh-Hans-CN"));
  return catalog.plugins
    .filter(plugin => {
      const haystack = [plugin.id, plugin.name, plugin.description, ...(plugin.tags ?? []), ...entrySkills(plugin)].join("\n").toLowerCase();
      return tokens.every(token => haystack.includes(token));
    })
    .sort((a, b) => a.name.localeCompare(b.name, "zh-Hans-CN"));
}

/** Downloaded, hash-verified file bytes. */
export interface FetchedFile {
  path: string;
  sha256: string;
  body: Buffer;
}

async function download(file: PluginFile, io: PluginIO): Promise<FetchedFile> {
  const fetchImpl = io.fetchImpl ?? fetch;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), Math.max(5_000, io.timeoutMs ?? 20_000));
  const cancel = (): void => controller.abort();
  io.signal?.addEventListener("abort", cancel);
  try {
    const response = await fetchImpl(file.url, { signal: controller.signal, headers: { "user-agent": "luban" } });
    if (!response.ok) throw new PluginError(`下载 ${file.path} 失败（HTTP ${response.status}）`);
    const body = Buffer.from(await response.arrayBuffer());
    if (body.length > MAX_FILE_BYTES) throw new PluginError(`${file.path} 超过 ${MAX_FILE_BYTES} 字节上限`);
    const digest = createHash("sha256").update(body).digest("hex");
    if (digest !== file.sha256) {
      throw new PluginError(`${file.path} 校验失败：sha256 ${digest.slice(0, 12)}…，目录里写的是 ${file.sha256.slice(0, 12)}…`);
    }
    return { path: file.path, sha256: digest, body };
  } finally {
    clearTimeout(timeout);
    io.signal?.removeEventListener("abort", cancel);
  }
}

/** Read `<home>/plugins.json`; a missing or damaged ledger reads as empty. */
export async function readInstallations(home: string): Promise<Installations> {
  let text: string;
  try { text = await readFile(ledgerPath(home), "utf8"); }
  catch { return {}; }
  try {
    const parsed = JSON.parse(text) as { installations?: unknown };
    const raw = parsed?.installations && typeof parsed.installations === "object" ? parsed.installations as Record<string, unknown> : {};
    const out: Installations = {};
    for (const [id, value] of Object.entries(raw)) {
      const record = value && typeof value === "object" ? value as Record<string, unknown> : {};
      const skills = Array.isArray(record.skills) ? record.skills.filter((name): name is string => typeof name === "string" && ID.test(name)) : [];
      const files = record.files && typeof record.files === "object" ? Object.fromEntries(
        Object.entries(record.files as Record<string, unknown>).filter((entry): entry is [string, string] => typeof entry[1] === "string"),
      ) : {};
      out[id] = {
        id,
        version: typeof record.version === "string" ? record.version : "",
        installedAt: typeof record.installedAt === "string" ? record.installedAt : "",
        skills,
        files,
      };
    }
    return out;
  } catch { return {}; }
}

async function writeInstallations(home: string, installations: Installations): Promise<void> {
  await mkdir(home, { recursive: true });
  const target = ledgerPath(home);
  const temporary = `${target}.${randomUUID()}.tmp`;
  await writeFile(temporary, `${JSON.stringify({ installations }, null, 2)}\n`, "utf8");
  await rename(temporary, target);
}

/**
 * Install one catalog entry.
 *
 * Download and verification happen before anything under `<home>/skills` is
 * touched, so a failed install leaves the previous state intact. A skill folder
 * that another plugin (or the user) already owns is a hard error rather than a
 * silent overwrite — two plugins claiming `commit-style` would make the agent's
 * behaviour depend on install order.
 */
export async function installPlugin(home: string, entry: PluginEntry, io: PluginIO = {}): Promise<InstalledPlugin> {
  const installations = await readInstallations(home);
  const previous = installations[entry.id];
  const files = await Promise.all(entry.files.map(file => download(file, io)));
  const skills = entrySkills(entry);
  const owned = new Set(previous?.skills ?? []);
  const root = skillsDir(home);
  for (const skill of skills) {
    if (existsSync(join(root, skill)) && !owned.has(skill)) {
      throw new PluginError(`技能 ${skill} 已存在（可能来自其他插件或手动安装），请先移除它`);
    }
  }
  const stage = join(root, `.luban-plugin-${randomUUID()}`);
  await mkdir(stage, { recursive: true });
  try {
    for (const file of files) {
      // Stripping `skills/` puts each payload folder directly under the stage,
      // so the final rename moves one skill folder, not the whole tree.
      const target = join(stage, file.path.slice(SKILL_ROOT.length + 1));
      await mkdir(dirname(target), { recursive: true });
      await writeFile(target, file.body, { mode: 0o644 });
    }
    for (const skill of skills) {
      await rm(join(root, skill), { recursive: true, force: true });
      await rename(join(stage, skill), join(root, skill));
    }
  } finally {
    await rm(stage, { recursive: true, force: true });
  }
  // Skills a previous version shipped but this one dropped should not linger.
  for (const skill of owned) if (!skills.includes(skill)) await rm(join(root, skill), { recursive: true, force: true });
  const record: InstalledPlugin = {
    id: entry.id,
    version: entry.version,
    installedAt: (io.now?.() ?? new Date()).toISOString(),
    skills,
    files: Object.fromEntries(files.map(file => [file.path, file.sha256])),
  };
  installations[entry.id] = record;
  await writeInstallations(home, installations);
  return record;
}

/** Remove a plugin's recorded skill folders and forget the ledger entry. */
export async function uninstallPlugin(home: string, id: string): Promise<string[]> {
  const installations = await readInstallations(home);
  const record = installations[id];
  if (!record) throw new PluginError(`插件 ${id} 没有安装记录`);
  for (const skill of record.skills) await rm(join(skillsDir(home), skill), { recursive: true, force: true });
  delete installations[id];
  await writeInstallations(home, installations);
  return record.skills;
}

/** Fetch and validate the catalog document. */
export async function fetchCatalog(url: string, io: PluginIO = {}): Promise<PluginCatalog> {
  const fetchImpl = io.fetchImpl ?? fetch;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), Math.max(5_000, io.timeoutMs ?? 15_000));
  const cancel = (): void => controller.abort();
  io.signal?.addEventListener("abort", cancel);
  try {
    const response = await fetchImpl(url, { signal: controller.signal, headers: { "user-agent": "luban", accept: "application/json" } });
    if (!response.ok) throw new PluginError(`插件目录读取失败（HTTP ${response.status}）：${url}`);
    const text = await response.text();
    if (text.length > 2_000_000) throw new PluginError("插件目录过大（>2MB）");
    let parsed: unknown;
    try { parsed = JSON.parse(text); }
    catch { throw new PluginError(`插件目录不是合法 JSON：${url}`); }
    return parseCatalog(parsed);
  } finally {
    clearTimeout(timeout);
    io.signal?.removeEventListener("abort", cancel);
  }
}

/** A catalog entry joined with its install state, which is what a storefront shows. */
export interface PluginView extends PluginEntry {
  installed?: InstalledPlugin;
  /** Installed version differs from the catalog version. */
  update?: boolean;
}

export function catalogView(catalog: PluginCatalog, installations: Installations, query = ""): PluginView[] {
  return searchPlugins(catalog, query).map(plugin => {
    const installed = installations[plugin.id];
    return { ...plugin, installed, update: Boolean(installed && installed.version !== plugin.version) };
  });
}
