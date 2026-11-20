/* The desktop workbench's half of the update flow.
 *
 * `core/update.ts` owns the check/download/swap logic and `/api/update` exposes
 * it to this page; `apps/desktop/main.cjs` exposes the same call over IPC
 * because only the main process can replace its own bundle and reopen it. This
 * file is the visible part: a dock in the sidebar footer that announces a new
 * build once per version, offers 升级 / 稍后 / 不再提醒, and carries the
 * "check on startup" switch the terminal writes with `luban update on|off`.
 *
 * The panel itself is a pure function of its props so the copy and the button
 * states are testable without a relay, a release server or an Electron window.
 */
import React, { useCallback, useEffect, useRef, useState } from "react";
import { api } from "./api";
import type { DesktopBridge } from "./desktop-bridge";

export interface UpdateSettings { check: boolean; skippedVersion: string }

export type UpdateStatus = "available" | "current" | "no-build" | "skipped" | "disabled" | "unreachable";

export interface UpdateState {
  status: UpdateStatus;
  current: string;
  latest?: string;
  notes?: string;
  reason?: string;
  artifact?: { version: string; file: string; size: number };
}

export interface UpdatePayload { settings: UpdateSettings; installing?: boolean; check: UpdateState }

export interface UpdatePanelProps {
  payload?: UpdatePayload;
  busy: boolean;
  error?: string;
  notice?: string;
  /** Present inside Electron; the browser build posts to `/api/update/install`. */
  bridge?: Pick<DesktopBridge, "checkUpdate" | "installUpdate">;
  onCheck(): void;
  onInstall(): void;
  onSkip(): void;
  onClose(): void;
  onToggleCheck(next: boolean): void;
}

/** One sentence for the state the release server reported. */
export function updateHeadline(state: UpdateState | undefined): string {
  if (!state) return "正在检查新版本…";
  switch (state.status) {
    case "available": return `新版本 ${state.latest ?? "?"} 可用（当前 ${state.current}）`;
    case "skipped": return `${state.latest ?? "新版本"} 已设为不再提醒（当前 ${state.current}）`;
    case "current": return `已是最新版本 ${state.current}`;
    case "no-build": return `${state.latest ?? "新版本"} 还没有这台电脑的安装包`;
    case "disabled": return "启动时检查更新已关闭";
    default: return "暂时连不上升级服务器";
  }
}

/** Release notes are one short paragraph in the dock, not a wall of text. */
export function updateNotes(text: string | undefined, limit = 220): string {
  const flat = (text ?? "").replace(/\r\n/gu, "\n").trim();
  if (!flat) return "";
  return flat.length > limit ? `${flat.slice(0, limit).trimEnd()}…` : flat;
}

function canInstall(state: UpdateState | undefined): boolean {
  return Boolean(state?.artifact) && (state?.status === "available" || state?.status === "skipped");
}

export function UpdatePanel(props: UpdatePanelProps): React.ReactElement {
  const { payload, busy, error, notice, bridge } = props;
  const state = payload?.check;
  const installable = canInstall(state);
  const notes = updateNotes(state?.notes);
  const checking = payload?.settings.check !== false;
  return (
    <div className="update-panel" role="dialog" aria-label="更新">
      <div className="update-head">
        <strong>更新</strong>
        <button className="update-close" aria-label="收起更新面板" onClick={props.onClose}>×</button>
      </div>
      <div className={`update-state ${state?.status ?? "checking"}`} role="status">{updateHeadline(state)}</div>
      {state?.status === "unreachable" && state.reason && <div className="update-hint">{state.reason}</div>}
      {notes && <div className="update-notes">{notes}</div>}
      {error && <div className="update-error" role="alert">{error}</div>}
      {notice && <div className="update-notice" role="status">{notice}</div>}
      <div className="update-actions">
        {installable && (
          <button className="primary" disabled={busy} onClick={props.onInstall}>
            {busy ? "升级中…" : `升级到 ${state?.artifact?.version ?? state?.latest ?? "新版本"}`}
          </button>
        )}
        {installable && (
          <button disabled={busy} onClick={props.onSkip}>不再提醒</button>
        )}
        {installable && (
          <button disabled={busy} onClick={props.onClose}>稍后</button>
        )}
        <button disabled={busy} onClick={props.onCheck}>{busy ? "检查中…" : "立即检查"}</button>
      </div>
      {bridge && installable && <div className="update-hint">升级会下载新版本、替换应用并自动重启。</div>}
      <label className="update-check">
        <input type="checkbox" checked={checking} disabled={busy}
          onChange={event => props.onToggleCheck(event.currentTarget.checked)} />
        <span>启动时检查更新</span>
      </label>
    </div>
  );
}

/**
 * Sidebar dock: a button that carries the current version and a dot while a
 * release is waiting, plus the panel above it.
 *
 * The check runs on mount — that is the "detect on startup" the user asked for —
 * and the panel opens itself once per version. Collapsing it is remembered for
 * the session, not written to disk: next launch should offer the update again.
 */
export function DesktopUpdate(): React.ReactElement {
  const bridge = typeof window === "undefined" ? undefined : window.lubanDesktop;
  const [payload, setPayload] = useState<UpdatePayload>();
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const [notice, setNotice] = useState<string>();
  const announced = useRef("");

  const load = useCallback(async (refresh: boolean) => {
    setBusy(true);
    setError(undefined);
    try {
      setPayload(await api.update(refresh));
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(false);
    }
  }, []);

  useEffect(() => { void load(false); }, [load]);

  const waiting = payload?.check.status === "available" ? payload.check.latest ?? "" : "";
  useEffect(() => {
    if (!waiting || announced.current === waiting) return;
    announced.current = waiting;
    setOpen(true);
  }, [waiting]);

  async function install(): Promise<void> {
    setBusy(true);
    setError(undefined);
    setNotice(undefined);
    try {
      if (bridge?.installUpdate) {
        const reply = await bridge.installUpdate();
        if (reply?.status === "installed") setNotice("已安装新版本，应用正在重启…");
        else if (reply?.status === "postponed") setNotice("已取消这次升级");
        else if (reply?.status === "skipped") setNotice("已设为不再提醒");
        else setError("升级没有完成，请稍后再试");
      } else {
        const reply = await api.installUpdate();
        setNotice(`已安装 ${reply.version}，重启 luban 后生效`);
      }
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(false);
    }
  }

  async function skip(): Promise<void> {
    const version = payload?.check.latest;
    if (!version) return;
    setBusy(true);
    setError(undefined);
    try {
      const reply = await api.saveUpdateSettings({ skippedVersion: version });
      setPayload(current => current ? { ...current, settings: reply.settings,
        check: { ...current.check, status: "skipped" } } : current);
      setNotice(`不再提醒 ${version}；仍可随时「立即检查」手动升级`);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(false);
    }
  }

  async function toggleCheck(next: boolean): Promise<void> {
    setBusy(true);
    setError(undefined);
    try {
      const reply = await api.saveUpdateSettings({ check: next });
      setPayload(current => current ? { ...current, settings: reply.settings,
        check: next ? current.check : { status: "disabled", current: current.check.current } } : current);
      if (next) await load(true);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(false);
    }
  }

  const status = payload?.check.status ?? "checking";
  return (
    <div className="update-dock">
      {open && (
        <UpdatePanel payload={payload} busy={busy} error={error} notice={notice} bridge={bridge}
          onCheck={() => void load(true)} onInstall={() => void install()} onSkip={() => void skip()}
          onClose={() => setOpen(false)} onToggleCheck={next => void toggleCheck(next)} />
      )}
      <button className={`update-button ${status}`} aria-expanded={open} aria-label="更新"
        title={payload ? updateHeadline(payload.check) : "检查更新"} onClick={() => setOpen(value => !value)}>
        <span>更新</span>
        {status === "available" && <span className="update-dot" aria-hidden="true" />}
      </button>
    </div>
  );
}
