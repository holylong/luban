import React, { useCallback, useEffect, useState } from "react";
import { api } from "./api.js";
import type { ComputerStatus } from "./types.js";

export type Notify = (text: string, error?: boolean) => void;

/** The one place the button turns OS permission state into a sentence. */
export function computerHint(status: ComputerStatus | undefined): string {
  if (!status) return "正在读取系统权限…";
  if (status.error) return status.error;
  const missing: string[] = [];
  if (status.accessibility === false || status.postEvent === false) missing.push("辅助功能（发送点击与键盘）");
  if (status.screenRecording === false) missing.push("屏幕录制（截屏）");
  if (!missing.length) return "luban 可以截屏、移动鼠标、点击和打字；开启后屏幕边缘会燃起蓝光，⌘. 随时收回";
  return `macOS 还缺${missing.join("、")}权限：系统设置 → 隐私与安全性，为 luban 勾选后重启 luban`;
}

export function computerLabel(status: ComputerStatus | undefined): string {
  if (!status) return "电脑操控";
  return status.enabled ? "操控中" : "电脑操控";
}

/**
 * The desk-side switch for synthetic input. Off by default and per machine:
 * the agent can only touch the pointer after a human turns this on, and the
 * desktop draws the burning rim so that fact is never invisible.
 */
export function ComputerToggle({ notify }: { notify: Notify }): React.ReactElement | null {
  const [status, setStatus] = useState<ComputerStatus | undefined>();
  const [pending, setPending] = useState(false);

  const refresh = useCallback(async () => {
    try { setStatus(await api.computer()); }
    catch { /* The pill simply stays absent until the backend answers. */ }
  }, []);

  useEffect(() => {
    let active = true;
    void refresh();
    const timer = setInterval(() => { if (active) void refresh(); }, 4_000);
    return () => { active = false; clearInterval(timer); };
  }, [refresh]);

  const toggle = useCallback(async () => {
    if (pending) return;
    setPending(true);
    try {
      if (status?.enabled) {
        await api.setComputer({ stop: true });
        setStatus(current => (current ? { ...current, enabled: false } : current));
        notify("已停止电脑操控");
      } else {
        await api.setComputer({ enabled: true });
        setStatus(current => (current ? { ...current, enabled: true } : { enabled: true, platform: "darwin" }));
        const hint = computerHint(status);
        const blocked = status?.accessibility === false || status?.postEvent === false || status?.screenRecording === false;
        notify(blocked ? hint : "电脑操控已开启，屏幕边缘亮起燃弧；⌘. 立即收回");
      }
    } catch (error) {
      notify(error instanceof Error ? error.message : String(error), true);
    } finally {
      setPending(false);
      void refresh();
    }
  }, [notify, pending, refresh, status]);

  // ⌘. also works inside the page, for a browser-console run without Electron.
  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === "." && (event.metaKey || event.ctrlKey) && status?.enabled) {
        event.preventDefault();
        void toggle();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [status?.enabled, toggle]);

  if (!status || status.platform !== "darwin") return null;
  return <ComputerButton status={status} pending={pending} onToggle={() => void toggle()} />;
}

/** Presentational half: the status line owns state, this owns the markup. */
export function ComputerButton({ status, pending, onToggle }: {
  status: ComputerStatus;
  pending?: boolean;
  onToggle: () => void;
}): React.ReactElement {
  const ready = status.accessibility !== false && status.postEvent !== false
    && status.screenRecording !== false && !status.error;
  return (
    <button
      type="button"
      className={`computer-toggle${status.enabled ? " on" : ""}${ready ? "" : " blocked"}`}
      onClick={onToggle}
      disabled={pending}
      title={computerHint(status)}
      aria-pressed={status.enabled}
    >
      <span className="dot" />
      {computerLabel(status)}
    </button>
  );
}
