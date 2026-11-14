import type React from "react";
import type { WorkbenchStore } from "./store";

export const isWebLink = (value: string): boolean => /^https?:\/\//iu.test(value);

export function isFileLink(value: string): boolean {
  return !/[\s<>]/u.test(value) && !/^[\w+.-]+:/u.test(value.replace(/:\d+(?::\d+)?$/u, ""))
    && /^(?:\.?\.?\/|\/|[\w@.-]+\/|[\w@.-]+\.[a-z\d]{1,12}(?::\d+(?::\d+)?)?$)/iu.test(value);
}

/** Absolute paths must belong to this project; main-process containment still applies. */
export function workspaceLink(value: string, root: string): string {
  let path = decodeURIComponent(value.replace(/^file:\/\//iu, "")).replace(/(?:#L\d+(?:C\d+)?|:\d+(?::\d+)?)$/u, "");
  const base = root.replace(/\/$/u, "");
  if (path.startsWith("/")) {
    if (!base || !path.startsWith(`${base}/`)) throw new Error("只能打开当前项目内的文件");
    path = path.slice(base.length + 1);
  }
  path = path.replace(/^\.\//u, "");
  if (path.split("/").includes("..")) throw new Error("只能打开当前项目内的文件");
  return path;
}

export async function openConversationLink(event: React.MouseEvent, store: WorkbenchStore): Promise<void> {
  const anchor = (event.target as Element).closest?.("a");
  if (!anchor) return;
  const href = anchor.getAttribute("href") ?? "";
  const file = anchor.dataset.filePath;
  const bridge = window.lubanDesktop;
  if (!file && !isWebLink(href)) return;
  if (!file && !bridge?.openExternal) return; // Browser links use target=_blank normally.
  event.preventDefault();
  try {
    if (file) {
      const path = workspaceLink(file, store.node?.projects?.[store.project] ?? store.job?.workspace ?? "");
      if (bridge?.openPath) await bridge.openPath(path);
      else await store.openFile(path);
    } else await bridge!.openExternal!(href);
  } catch (error) { store.notify(error instanceof Error ? error.message : String(error), true); }
}
