import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  catalogView, entrySkills, fetchCatalog, installPlugin, parseCatalog, PluginError, readInstallations,
  searchPlugins, skillOfPath, uninstallPlugin, type PluginCatalog, type PluginEntry,
} from "./plugins.js";

const digest = (body: string): string => createHash("sha256").update(body).digest("hex");
const skill = "---\nname: commit-chinese\ndescription: 中文提交信息\n---\n\n写提交信息时用中文。\n";

/** A fetch that serves canned bodies by URL and records what was asked for. */
function serveFiles(files: Record<string, string>): { fetchImpl: typeof fetch; calls: string[] } {
  const calls: string[] = [];
  const fetchImpl = (async (input: string | URL | Request) => {
    const url = String(input);
    calls.push(url);
    const body = files[url];
    if (body === undefined) return new Response("not found", { status: 404 });
    return new Response(body, { status: 200 });
  }) as unknown as typeof fetch;
  return { fetchImpl, calls };
}

function entryFrom(files: Record<string, string>, overrides: Partial<PluginEntry> = {}): PluginEntry {
  return {
    id: "commit-chinese",
    name: "中文提交信息",
    version: "1.0.0",
    description: "提交信息写中文，先写一句话再列要点。",
    tags: ["git", "中文"],
    files: Object.entries(files).map(([path, body]) => ({
      path,
      url: `https://example.test/plugins/${path}`,
      sha256: digest(body),
      bytes: Buffer.byteLength(body),
    })),
    ...overrides,
  };
}

function catalogOf(...plugins: PluginEntry[]): PluginCatalog {
  return { schemaVersion: 1, plugins };
}

describe("plugin catalog", () => {
  it("derives skill folders from manifest paths", () => {
    expect(skillOfPath("skills/commit-chinese/SKILL.md")).toBe("commit-chinese");
    expect(entrySkills(entryFrom({ "skills/a/SKILL.md": "x", "skills/b/notes/x.md": "y" }))).toEqual(["a", "b"]);
  });

  it("rejects escapes and absolute paths", () => {
    for (const path of ["../evil/SKILL.md", "/etc/passwd", "skills/../../x.md", "C:\\skills\\x.md", "skills/x.md", "other/x.md"]) {
      expect(() => skillOfPath(path), path).toThrow(PluginError);
    }
  });

  it("rejects a malformed catalog instead of serving half a storefront", () => {
    const file = { path: "skills/a/SKILL.md", url: "https://example.test/a", sha256: digest(skill) };
    expect(() => parseCatalog({ schemaVersion: 2, plugins: [] })).toThrow(/schemaVersion/u);
    expect(() => parseCatalog({ schemaVersion: 1 })).toThrow(/plugins/u);
    expect(() => parseCatalog({ schemaVersion: 1, plugins: [{ id: "a", name: "a", version: "1", description: "d", files: [] }] })).toThrow(/没有文件/u);
    expect(() => parseCatalog({ schemaVersion: 1, plugins: [{ id: "a", name: "a", version: "1", description: "d", files: [{ ...file, url: "http://example.test/a" }] }] })).toThrow(/https/u);
    expect(() => parseCatalog({ schemaVersion: 1, plugins: [{ id: "a", name: "a", version: "1", description: "d", files: [{ ...file, sha256: "abc" }] }] })).toThrow(/sha256/u);
    expect(() => parseCatalog({ schemaVersion: 1, plugins: [
      { id: "a", name: "a", version: "1", description: "d", files: [file] },
      { id: "a", name: "b", version: "1", description: "d", files: [file] },
    ] })).toThrow(/id 重复/u);
  });

  it("searches ids, descriptions, tags and skill names with every token required", () => {
    const git = entryFrom({ "skills/commit-chinese/SKILL.md": skill });
    const sql = entryFrom({ "skills/sql-review/SKILL.md": "---\nx\n---\n" }, { id: "sql-review", name: "SQL 审阅", description: "审查慢查询", tags: ["数据库"] });
    const catalog = catalogOf(git, sql);
    expect(searchPlugins(catalog, "").map(plugin => plugin.id)).toEqual(["commit-chinese", "sql-review"]);
    expect(searchPlugins(catalog, "git 中文").map(plugin => plugin.id)).toEqual(["commit-chinese"]);
    expect(searchPlugins(catalog, "慢查询").map(plugin => plugin.id)).toEqual(["sql-review"]);
    expect(searchPlugins(catalog, "commit-chinese 数据库")).toEqual([]);
    expect(searchPlugins(catalog, "中文 数据库")).toEqual([]);
  });
});

describe("plugin install", () => {
  it("downloads, verifies and writes skills where discovery looks", async () => {
    const home = await mkdtemp(join(tmpdir(), "luban-plugins-"));
    const files = { "skills/commit-chinese/SKILL.md": skill };
    const entry = entryFrom(files);
    const { fetchImpl, calls } = serveFiles(Object.fromEntries(entry.files.map(file => [file.url, files["skills/commit-chinese/SKILL.md"]!])));
    const record = await installPlugin(home, entry, { fetchImpl, now: () => new Date("2026-11-22T09:00:00.000Z") });
    expect(calls).toHaveLength(1);
    expect(record).toEqual({
      id: "commit-chinese", version: "1.0.0", installedAt: "2026-11-22T09:00:00.000Z",
      skills: ["commit-chinese"], files: { "skills/commit-chinese/SKILL.md": digest(skill) },
    });
    expect(await readFile(join(home, "skills", "commit-chinese", "SKILL.md"), "utf8")).toBe(skill);
    expect((await readInstallations(home))["commit-chinese"]?.version).toBe("1.0.0");
    const ledger = JSON.parse(await readFile(join(home, "plugins.json"), "utf8")) as { installations: Record<string, unknown> };
    expect(Object.keys(ledger.installations)).toEqual(["commit-chinese"]);
  });

  it("fails closed on a hash mismatch and leaves no skill folder", async () => {
    const home = await mkdtemp(join(tmpdir(), "luban-plugins-"));
    const entry = entryFrom({ "skills/commit-chinese/SKILL.md": skill });
    const { fetchImpl } = serveFiles({ [entry.files[0]!.url]: "tampered" });
    await expect(installPlugin(home, entry, { fetchImpl })).rejects.toThrow(/校验失败/u);
    expect(existsSync(join(home, "skills", "commit-chinese"))).toBe(false);
    expect(await readInstallations(home)).toEqual({});
  });

  it("refuses to overwrite a skill it does not own", async () => {
    const home = await mkdtemp(join(tmpdir(), "luban-plugins-"));
    const files = { "skills/commit-chinese/SKILL.md": skill };
    await mkdir(join(home, "skills", "commit-chinese"), { recursive: true });
    await writeFile(join(home, "skills", "commit-chinese", "SKILL.md"), "手写的技能\n");
    const entry = entryFrom(files);
    const { fetchImpl } = serveFiles({ [entry.files[0]!.url]: skill });
    await expect(installPlugin(home, entry, { fetchImpl })).rejects.toThrow(/已存在/u);
    expect(await readFile(join(home, "skills", "commit-chinese", "SKILL.md"), "utf8")).toBe("手写的技能\n");
  });

  it("reinstalls its own skill and uninstalls exactly what it recorded", async () => {
    const home = await mkdtemp(join(tmpdir(), "luban-plugins-"));
    const first = { "skills/commit-chinese/SKILL.md": skill };
    const entry = entryFrom(first);
    const serve = serveFiles({ [entry.files[0]!.url]: skill });
    await installPlugin(home, entry, { fetchImpl: serve.fetchImpl });
    const second = skill.replace("中文", "简体中文");
    const upgrade = entryFrom({ "skills/commit-chinese/SKILL.md": second }, { version: "1.1.0" });
    await installPlugin(home, upgrade, { fetchImpl: serveFiles({ [upgrade.files[0]!.url]: second }).fetchImpl });
    expect(await readFile(join(home, "skills", "commit-chinese", "SKILL.md"), "utf8")).toBe(second);
    expect((await readInstallations(home))["commit-chinese"]?.version).toBe("1.1.0");
    const removed = await uninstallPlugin(home, "commit-chinese");
    expect(removed).toEqual(["commit-chinese"]);
    expect(existsSync(join(home, "skills", "commit-chinese"))).toBe(false);
    expect(await readInstallations(home)).toEqual({});
  });

  it("keeps unrelated skills on uninstall", async () => {
    const home = await mkdtemp(join(tmpdir(), "luban-plugins-"));
    await mkdir(join(home, "skills", "manual"), { recursive: true });
    await writeFile(join(home, "skills", "manual", "SKILL.md"), "自己的\n");
    const entry = entryFrom({ "skills/commit-chinese/SKILL.md": skill });
    await installPlugin(home, entry, { fetchImpl: serveFiles({ [entry.files[0]!.url]: skill }).fetchImpl });
    await uninstallPlugin(home, "commit-chinese");
    expect(existsSync(join(home, "skills", "manual", "SKILL.md"))).toBe(true);
  });
});

describe("plugin catalog fetch and view", () => {
  it("reads the catalog over https and reports the URL that failed", async () => {
    const body = JSON.stringify(catalogOf(entryFrom({ "skills/commit-chinese/SKILL.md": skill })));
    const ok = await fetchCatalog("https://example.test/plugins.json", { fetchImpl: serveFiles({ "https://example.test/plugins.json": body }).fetchImpl });
    expect(ok.plugins[0]?.name).toBe("中文提交信息");
    await expect(fetchCatalog("https://example.test/missing.json", { fetchImpl: serveFiles({}).fetchImpl })).rejects.toThrow(/HTTP 404/u);
    await expect(fetchCatalog("https://example.test/bad.json", { fetchImpl: serveFiles({ "https://example.test/bad.json": "{" }).fetchImpl })).rejects.toThrow(/不是合法 JSON/u);
  });

  it("marks a catalog version that differs from the installed one as an update", () => {
    const entry = entryFrom({ "skills/commit-chinese/SKILL.md": skill }, { version: "2.0.0" });
    const view = catalogView(catalogOf(entry), {
      "commit-chinese": { id: "commit-chinese", version: "1.0.0", installedAt: "", skills: ["commit-chinese"], files: {} },
    });
    expect(view[0]?.installed?.version).toBe("1.0.0");
    expect(view[0]?.update).toBe(true);
    expect(catalogView(catalogOf(entry), {})[0]?.installed).toBeUndefined();
  });
});
