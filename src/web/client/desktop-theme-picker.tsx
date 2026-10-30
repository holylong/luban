import React, { useEffect, useRef, useState } from "react";
import { api } from "./api";
import { paintDesktopTheme, type ThemeCatalog } from "./desktop-theme";

export function DesktopThemePicker({ notify }: { notify: (text: string, error?: boolean) => void }): React.ReactElement {
  const [catalog, setCatalog] = useState<ThemeCatalog>();
  const [busy, setBusy] = useState(false);
  const notifyRef = useRef(notify);
  notifyRef.current = notify;
  useEffect(() => {
    let active = true;
    api.themes().then(next => {
      if (active) { setCatalog(next); paintDesktopTheme(next.active); }
    }).catch(error => { if (active) notifyRef.current(`无法读取主题：${String(error)}`, true); });
    return () => { active = false; };
  }, []);
  const select = async (id: string): Promise<void> => {
    setBusy(true);
    try {
      const result = await api.setTheme(id);
      paintDesktopTheme(result.active);
      setCatalog(current => current ? { ...current, active: result.active } : current);
    } catch (error) { notify(`无法保存主题：${String(error)}`, true); }
    finally { setBusy(false); }
  };
  return <div className="desktop-theme-picker">
    <label htmlFor="desktop-theme">主题</label>
    <select id="desktop-theme" aria-label="主题" value={catalog?.active.id ?? ""} disabled={!catalog || busy} onChange={event => void select(event.target.value)}>
      {!catalog && <option value="">读取主题…</option>}
      {catalog?.themes.map(theme => <option key={theme.id} value={theme.id}>{theme.label} · {theme.mode === "light" ? "浅色" : "深色"} · {theme.description}</option>)}
    </select>
  </div>;
}
