import React, { useEffect, useRef } from "react";
import type { DesktopBridge } from "./desktop-bridge";

export type FileMenuAction = "open" | "reveal" | "copy" | "new-file" | "new-folder" | "rename" | "trash";

export interface FileMenuTarget {
  /** Workspace-relative path. */
  path: string;
  type: "file" | "dir";
}

export interface FileMenuEntry {
  action: FileMenuAction;
  label: string;
  /** Needs the desktop bridge; a browser preview cannot touch the disk. */
  needsDesktop?: boolean;
}

/** What a right-click offers. Folders can host a new entry, files cannot, and
 *  the root listing (no target) only offers the two create actions. */
export function fileMenuEntries(target: FileMenuTarget | undefined): FileMenuEntry[] {
  if (!target) {
    return [
      { action: "new-file", label: "新建文件", needsDesktop: true },
      { action: "new-folder", label: "新建文件夹", needsDesktop: true },
    ];
  }
  const dir = target.type === "dir";
  const entries: FileMenuEntry[] = [
    { action: "open", label: dir ? "展开 / 收起" : "打开" },
    { action: "reveal", label: "在访达中显示", needsDesktop: true },
    { action: "copy", label: "复制路径", needsDesktop: true },
  ];
  if (dir) entries.push({ action: "new-file", label: "在此新建文件", needsDesktop: true });
  if (dir) entries.push({ action: "new-folder", label: "在此新建文件夹", needsDesktop: true });
  entries.push({ action: "rename", label: "重命名", needsDesktop: true });
  entries.push({ action: "trash", label: "移到废纸篓", needsDesktop: true });
  return entries;
}

/** Parent folder of a workspace path ("" is the workspace root). */
export function parentPath(path: string): string {
  const cut = path.lastIndexOf("/");
  return cut <= 0 ? "" : path.slice(0, cut);
}

export function joinPath(dir: string, name: string): string {
  return dir ? `${dir}/${name}` : name;
}

/** Names the workspace service would reject anyway; refuse them here so the row
 *  can show a sentence instead of an IPC error. */
export function nameProblem(name: string): string | undefined {
  const value = name.trim();
  if (!value) return "名字不能为空";
  if (value === "." || value === "..") return "这个名字不可用";
  if (/[/\\]/.test(value)) return "名字里不能包含斜杠";
  if (value.includes("\0")) return "名字里不能包含控制字符";
  if ([".git", "node_modules", "dist"].includes(value)) return `${value} 由 luban 保留，不能作为名字`;
  return undefined;
}

/** Keep the menu inside the window: a right-click near the bottom edge would
 *  otherwise open it off-screen. */
export function menuPosition(x: number, y: number, count: number, viewport?: { width: number; height: number }): { left: number; top: number } {
  const width = viewport?.width || 1024;
  const height = viewport?.height || 800;
  return {
    left: Math.max(4, Math.min(x, width - 190)),
    top: Math.max(4, Math.min(y, height - 20 - count * 28)),
  };
}

export function FileMenu({ x, y, target, bridge, onAction, onClose }: {
  x: number;
  y: number;
  target?: FileMenuTarget;
  bridge?: DesktopBridge;
  onAction(action: FileMenuAction, target?: FileMenuTarget): void;
  onClose(): void;
}): React.ReactElement {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const away = (event: MouseEvent): void => {
      if (!ref.current?.contains(event.target as Node)) onClose();
    };
    const key = (event: KeyboardEvent): void => { if (event.key === "Escape") onClose(); };
    window.addEventListener("mousedown", away);
    window.addEventListener("keydown", key);
    return () => { window.removeEventListener("mousedown", away); window.removeEventListener("keydown", key); };
  }, [onClose]);
  const entries = fileMenuEntries(target);
  const spot = menuPosition(x, y, entries.length, typeof window === "undefined" ? undefined : { width: window.innerWidth, height: window.innerHeight });
  return <div
    className="desktop-menu"
    role="menu"
    ref={ref}
    style={{ left: spot.left, top: spot.top }}
    onContextMenu={event => event.preventDefault()}
  >
    {entries.map(entry => <button
      key={entry.action}
      role="menuitem"
      className={entry.action === "trash" ? "danger" : undefined}
      disabled={Boolean(entry.needsDesktop) && !bridge}
      title={entry.needsDesktop && !bridge ? "浏览器里不能改本机文件，请用 luban 桌面版" : undefined}
      onClick={() => { onAction(entry.action, target); onClose(); }}
    >{entry.label}</button>)}
  </div>;
}
