import React from "react";
import type { DesktopBridge } from "./desktop-bridge";

/** Hand a read-only preview to the application the OS associates with its type
 * (PowerPoint for a deck, Preview for a PDF). Hidden when the bridge predates it. */
export function OpenExternalButton({ path }: { path: string }): React.ReactElement | null {
  const bridge: DesktopBridge | undefined = typeof window === "undefined" ? undefined : window.lubanDesktop;
  if (!bridge?.openPath) return null;
  return <button onClick={() => { void bridge.openPath!(path).catch(() => {}); }}>用系统应用打开</button>;
}
