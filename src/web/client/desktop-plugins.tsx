/* The desktop workbench's plugin store.
 *
 * core/plugins.ts owns the catalog format and the download/verify/write path;
 * `/api/plugins` exposes it. This file is the visible part: a dock in the status
 * bar that opens a searchable list, installs on one click and uninstalls without
 * leaving a trace in `<home>/skills`.
 *
 * A plugin here is a skill pack — markdown the model reads on demand — so the
 * panel says that plainly instead of implying new tools or code run on install.
 * The panel is a pure function of its props so the copy and the button states
 * are testable without a relay or a network.
 */
import React, { useCallback, useEffect, useRef, useState } from "react";
import { api } from "./api";

/** Ledger entry: what one install owns. Mirrors `core/plugins.ts`. */
export interface InstalledPluginView {
  id: string;
  version: string;
  installedAt: string;
  skills: string[];
  files: Record<string, string>;
}

/** Catalog entry joined with its install state, as the server sends it. */
export interface PluginView {
  id: string;
  name: string;
  version: string;
  description: string;
  author?: string;
  homepage?: string;
  license?: string;
  tags?: string[];
  skills?: string[];
  installed?: InstalledPluginView;
  update?: boolean;
}

export interface PluginPayload {
  /** Catalog URL that answered, shown so a mirror is recognisable. */
  registry: string;
  updatedAt?: string;
  plugins: PluginView[];
  /** Installed packs; present even when the catalog could not be read. */
  installed: InstalledPluginView[];
  /** Set when the catalog itself failed; the installed list still works. */
  error?: string;
}

export interface PluginPanelProps {
  payload?: PluginPayload;
  query: string;
  busy: boolean;
  /** Id of the row whose install/uninstall is running. */
  busyId?: string;
  error?: string;
  notice?: string;
  onQuery(next: string): void;
  onRefresh(): void;
  onInstall(plugin: PluginView): void;
  onUninstall(plugin: PluginView): void;
  onClose(): void;
}

/** One line of context above the list: how much is there and which catalog. */
export function pluginHeadline(payload: PluginPayload | undefined, query: string): string {
  if (!payload) return "正在读取插件目录…";
  if (payload.error) return "插件目录暂时读不到，已安装的仍可管理";
  const total = payload.plugins.length;
  const scope = query.trim() ? `匹配「${query.trim()}」的` : "";
  return `${scope}${total} 个插件 · 已安装 ${payload.installed.length} 个`;
}

/** Installed state as one short badge, or nothing for a fresh entry. */
export function pluginBadge(plugin: PluginView): string {
  if (!plugin.installed) return "";
  return plugin.update ? `可更新 ${plugin.installed.version} → ${plugin.version}` : `已安装 ${plugin.installed.version}`;
}

function actionsFor(plugin: PluginView, busy: boolean, busyId: string | undefined,
  onInstall: (plugin: PluginView) => void, onUninstall: (plugin: PluginView) => void): React.ReactElement {
  const working = busy && busyId === plugin.id;
  const label = plugin.installed ? (plugin.update ? "更新" : "重新安装") : "安装";
  return (
    <div className="plugin-actions">
      <button className={plugin.installed ? undefined : "primary"} disabled={busy}
        onClick={() => onInstall(plugin)}>
        {working ? "处理中…" : label}
      </button>
      {plugin.installed && (
        <button disabled={busy} onClick={() => onUninstall(plugin)}>卸载</button>
      )}
    </div>
  );
}

export function PluginPanel(props: PluginPanelProps): React.ReactElement {
  const { payload, query, busy, busyId, error, notice } = props;
  const plugins = payload?.plugins ?? [];
  const installed = payload?.installed ?? [];
  // The catalog can be unreachable while the ledger is fine, so an installed
  // pack that is not in the list still gets a row with its uninstall button.
  const orphans = installed.filter(item => !plugins.some(plugin => plugin.id === item.id));
  return (
    <div className="plugin-panel" role="dialog" aria-label="插件">
      <div className="plugin-head">
        <strong>插件</strong>
        <div className="plugin-head-actions">
          <button className="plugin-refresh" disabled={busy} onClick={props.onRefresh}
            title="重新读取插件目录">刷新</button>
          <button className="plugin-close" aria-label="收起插件面板" onClick={props.onClose}>×</button>
        </div>
      </div>
      <label className="plugin-search">
        <input type="search" value={query} placeholder="搜索插件：名称、描述、标签" aria-label="搜索插件"
          onChange={event => props.onQuery(event.currentTarget.value)} />
      </label>
      <div className={`plugin-state${payload?.error ? " error" : ""}`} role="status">
        {pluginHeadline(payload, query)}
      </div>
      {payload?.error && <div className="plugin-error" role="alert">{payload.error}</div>}
      {error && <div className="plugin-error" role="alert">{error}</div>}
      {notice && <div className="plugin-notice" role="status">{notice}</div>}
      <div className="plugin-list">
        {plugins.map(plugin => {
          const badge = pluginBadge(plugin);
          return (
            <div className="plugin-row" key={plugin.id} data-plugin={plugin.id}>
              <div className="plugin-row-head">
                <span className="plugin-name">{plugin.name}</span>
                <span className="plugin-version">{plugin.version}</span>
                {badge && <span className={`plugin-badge${plugin.update ? " update" : ""}`}>{badge}</span>}
              </div>
              <div className="plugin-desc">{plugin.description}</div>
              <div className="plugin-meta">
                {(plugin.tags ?? []).map(tag => <span className="plugin-tag" key={tag}>{tag}</span>)}
                {(plugin.skills ?? []).length > 0 && (
                  <span className="plugin-skills">技能：{(plugin.skills ?? []).join("、")}</span>
                )}
              </div>
              {actionsFor(plugin, busy, busyId, props.onInstall, props.onUninstall)}
            </div>
          );
        })}
        {orphans.map(item => (
          <div className="plugin-row" key={item.id} data-plugin={item.id}>
            <div className="plugin-row-head">
              <span className="plugin-name">{item.id}</span>
              <span className="plugin-badge">已安装 {item.version}</span>
            </div>
            <div className="plugin-meta"><span className="plugin-skills">技能：{item.skills.join("、") || "—"}</span></div>
            <div className="plugin-actions">
              <button disabled={busy} onClick={() => props.onUninstall({
                id: item.id, name: item.id, version: item.version, description: "", installed: item,
              })}>卸载</button>
            </div>
          </div>
        ))}
        {payload && !plugins.length && !orphans.length && (
          <div className="plugin-empty">{query.trim() ? `没有匹配「${query.trim()}」的插件` : "目录里还没有插件"}</div>
        )}
      </div>
      <div className="plugin-hint">插件就是技能包：装好后 <code>list_skills</code> 立刻能看到，不用重启。</div>
    </div>
  );
}

/**
 * Status-bar dock. The catalog is only fetched when the panel is first opened —
 * a storefront is not worth a request on every launch — and typing filters
 * server-side against the cached catalog.
 */
export function DesktopPlugins(): React.ReactElement {
  const [open, setOpen] = useState(false);
  const [payload, setPayload] = useState<PluginPayload>();
  const [query, setQuery] = useState("");
  const [busy, setBusy] = useState(false);
  const [busyId, setBusyId] = useState<string>();
  const [error, setError] = useState<string>();
  const [notice, setNotice] = useState<string>();
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const requested = useRef(false);

  const load = useCallback(async (nextQuery: string, refresh: boolean) => {
    setBusy(true);
    setError(undefined);
    try {
      setPayload(await api.plugins(nextQuery, refresh));
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(false);
    }
  }, []);

  useEffect(() => {
    if (!open || requested.current) return;
    requested.current = true;
    void load("", false);
  }, [open, load]);

  useEffect(() => () => { if (timer.current) clearTimeout(timer.current); }, []);

  function search(next: string): void {
    setQuery(next);
    if (timer.current) clearTimeout(timer.current);
    // The catalog is cached server-side, so a short debounce is enough and the
    // list never races the keystrokes.
    timer.current = setTimeout(() => void load(next, false), 220);
  }

  async function install(plugin: PluginView): Promise<void> {
    setBusy(true);
    setBusyId(plugin.id);
    setError(undefined);
    setNotice(undefined);
    try {
      const reply = await api.installPlugin(plugin.id);
      setNotice(`已安装「${plugin.name}」${reply.installed.skills.length} 个技能：${reply.installed.skills.join("、")}`);
      await load(query, false);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(false);
      setBusyId(undefined);
    }
  }

  async function uninstall(plugin: PluginView): Promise<void> {
    setBusy(true);
    setBusyId(plugin.id);
    setError(undefined);
    setNotice(undefined);
    try {
      const reply = await api.uninstallPlugin(plugin.id);
      setNotice(`已卸载「${plugin.name}」，删除技能：${reply.skills.join("、") || "—"}`);
      await load(query, false);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(false);
      setBusyId(undefined);
    }
  }

  const count = payload?.plugins.length ?? 0;
  return (
    <div className="plugin-dock">
      {open && (
        <PluginPanel payload={payload} query={query} busy={busy} busyId={busyId} error={error} notice={notice}
          onQuery={search} onRefresh={() => void load(query, true)}
          onInstall={plugin => void install(plugin)} onUninstall={plugin => void uninstall(plugin)}
          onClose={() => setOpen(false)} />
      )}
      <button className="plugin-button" aria-expanded={open} aria-label="插件"
        title={payload ? `插件：${count} 个可用` : "浏览插件"} onClick={() => setOpen(value => !value)}>
        <span>插件</span>
      </button>
    </div>
  );
}
