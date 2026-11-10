import React, { useEffect, useRef, useState } from "react";
import { api } from "./api";
import type { CodexQuota, CodexResetCredit } from "../codex-quota-types";

function creditLabel(credit: CodexResetCredit): string {
  return credit.expiresAt != null ? `${credit.title} · ${new Date(credit.expiresAt * 1000).toLocaleDateString()} 到期` : credit.title;
}

function newRequestId(): string {
  // crypto.randomUUID only exists in secure contexts; the LAN console may be plain http.
  return globalThis.crypto?.randomUUID?.() ?? `luban-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 12)}`;
}

export function CodexQuotaView({ quota, loading = false, refresh, onReset, resetting = false, resetMessage, resetError }: {
  quota?: CodexQuota;
  loading?: boolean;
  refresh?(): void;
  /** Spend one reset card; `creditId` is omitted when Codex gives no card ids. */
  onReset?(creditId?: string): void;
  resetting?: boolean;
  resetMessage?: string;
  resetError?: string;
}): React.ReactElement {
  const credits = quota?.credits ?? [];
  const available = quota?.availableResetCredits ?? 0;
  const [selected, setSelected] = useState("");
  const [confirming, setConfirming] = useState(false);
  // A stale selection must not point at a card that is already gone.
  const chosen = credits.some(credit => credit.id === selected) ? selected : credits[0]?.id ?? "";
  return <section className="desktop-codex-quota" aria-label="Codex 剩余额度">
    <header><b>Codex 剩余额度</b><button disabled={loading} onClick={refresh} title="额度数据缓存 1 分钟">{loading ? "查询中…" : "刷新"}</button></header>
    {!quota && <small>{loading ? "正在查询账户额度…" : "暂无额度数据"}</small>}
    {quota?.error && <p role="status">{quota.error}{quota.updatedAt ? " 以下为上次成功查询的数据。" : ""}</p>}
    {quota?.hint && <p className="desktop-quota-hint" role="status">{quota.hint}</p>}
    {quota?.detail && <small className="desktop-quota-detail">{quota.detail}</small>}
    {quota && !quota.error && !quota.windows.length && <p>账号未返回额度窗口；请确认已用 ChatGPT 账号登录 Codex。</p>}
    {quota?.windows.map(window => <div key={window.id} className={`desktop-quota-window${window.remaining <= 20 ? " low" : ""}`}>
      <div><span>{window.label}{window.durationMins ? ` · ${window.durationMins >= 60 ? `${Number((window.durationMins / 60).toFixed(1))}小时` : `${window.durationMins}分钟`}` : ""}</span><strong>{window.remaining.toFixed(1)}%{window.remaining <= 20 ? " · 额度偏低" : ""}</strong></div>
      <progress max={100} value={window.remaining} aria-label={`${window.label}剩余百分比`} />
      {window.resetsAt != null && <small>{new Date(window.resetsAt * 1000).toLocaleString()} 重置</small>}
    </div>)}
    {available > 0 && <div className="desktop-quota-reset">
      <div><span>可用重置卡 {available} 张</span>
        {credits.length > 1 && <select aria-label="选择重置卡" value={chosen} disabled={resetting}
          onChange={(event) => { setSelected(event.target.value); setConfirming(false); }}>
          {credits.map(credit => <option key={credit.id} value={credit.id}>{creditLabel(credit)}</option>)}
        </select>}
        {credits.length === 1 && <small>{creditLabel(credits[0]!)}</small>}
      </div>
      {confirming
        ? <div className="desktop-quota-actions">
            <small>重置会立刻消耗 1 张重置卡，确定使用？</small>
            <button className="danger" disabled={resetting} onClick={() => { setConfirming(false); onReset?.(chosen || undefined); }}>
              {resetting ? "重置中…" : "确认使用"}</button>
            <button disabled={resetting} onClick={() => setConfirming(false)}>取消</button>
          </div>
        : <button disabled={resetting || !onReset} onClick={() => setConfirming(true)}>
            {resetting ? "重置中…" : "使用重置卡"}</button>}
    </div>}
    {resetMessage && <p className="desktop-quota-result" role="status">{resetMessage}</p>}
    {resetError && <p className="desktop-error" role="alert">{resetError}</p>}
    {quota?.updatedAt != null && <small>更新于 {new Date(quota.updatedAt).toLocaleTimeString()} · 每分钟刷新</small>}
  </section>;
}

export function DesktopCodexQuota({ provider, modelId }: { provider?: string; modelId?: string }): React.ReactElement | null {
  const [quota, setQuota] = useState<CodexQuota>();
  const [loading, setLoading] = useState(false);
  const [resetting, setResetting] = useState(false);
  const [resetMessage, setResetMessage] = useState<string>();
  const [resetError, setResetError] = useState<string>();
  const [revision, setRevision] = useState(0);
  // Kept until Codex reports a definite outcome, so a retry cannot spend a second card.
  const requestId = useRef<string | undefined>(undefined);
  const read = async (force: boolean) => {
    if (!force && document.visibilityState === "hidden") return;
    setLoading(true);
    try { setQuota(await api.codexQuota()); }
    catch { setQuota(current => ({ ...current, windows: current?.windows ?? [], error: "额度查询失败，请稍后刷新。" })); }
    finally { setLoading(false); }
  };
  useEffect(() => {
    if (provider !== "codex") return;
    let disposed = false;
    let pending = false;
    setQuota(undefined);
    const load = async () => {
      if (pending || document.visibilityState === "hidden") return;
      pending = true;
      setLoading(true);
      try { const result = await api.codexQuota(); if (!disposed) setQuota(result); }
      catch { if (!disposed) setQuota(current => ({ ...current, windows: current?.windows ?? [], error: "额度查询失败，请稍后刷新。" })); }
      finally { pending = false; if (!disposed) setLoading(false); }
    };
    void load();
    const timer = window.setInterval(() => { void load(); }, 60_000);
    const visible = () => { if (document.visibilityState === "visible") void load(); };
    document.addEventListener("visibilitychange", visible);
    return () => { disposed = true; window.clearInterval(timer); document.removeEventListener("visibilitychange", visible); };
  }, [provider, modelId, revision]);
  if (provider !== "codex") return null;
  const reset = async (creditId?: string) => {
    if (resetting) return;
    const id = requestId.current ?? (requestId.current = newRequestId());
    setResetting(true);
    setResetMessage(undefined);
    setResetError(undefined);
    try {
      const result = await api.codexReset({ creditId, requestId: id });
      requestId.current = undefined;
      setResetMessage(result.message);
      setQuota(result.quota);
    } catch (error) {
      // Outcome unknown: keep the id so retrying the same intent stays idempotent.
      setResetError(`${error instanceof Error ? error.message : String(error)} 请先刷新额度确认，再决定是否重试。`);
      void read(true);
    } finally {
      setResetting(false);
    }
  };
  return <CodexQuotaView quota={quota} loading={loading} refresh={() => setRevision(value => value + 1)}
    onReset={(creditId) => { void reset(creditId); }} resetting={resetting}
    resetMessage={resetMessage} resetError={resetError} />;
}
