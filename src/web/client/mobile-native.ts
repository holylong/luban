/** Status the page hands to a native shell that draws its own chrome.
 *
 * The Android shell (`apps/android-app`) hosts this console in a WebView and
 * paints a native strip above it. Without a report the strip can only say
 * "已连接", so a phone owner cannot tell whether the computer is still working
 * once the transcript scrolls. A plain browser has no bridge at all and this
 * module then does nothing.
 */
export interface NativeTaskStatus {
  working: boolean;
  label?: string;
  detail?: string;
  seconds?: number;
  stalled?: boolean;
}

interface LubanShellBridge {
  setTaskStatus?(payload: string): void;
}

/** The object name must match `addJavascriptInterface(..., "lubanShell")`. */
export function reportNativeStatus(status: NativeTaskStatus): void {
  const bridge = (globalThis as { lubanShell?: LubanShellBridge }).lubanShell;
  if (!bridge || typeof bridge.setTaskStatus !== "function") return;
  try {
    bridge.setTaskStatus(JSON.stringify(status));
  } catch {
    // A destroyed WebView throws; the console itself keeps working.
  }
}
