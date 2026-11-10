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
  setConnected?(connected: boolean): void;
  openMenu?(): void;
}

function shellBridge(): LubanShellBridge | undefined {
  return (globalThis as { lubanShell?: LubanShellBridge }).lubanShell;
}

/** True inside the Android shell, which draws its own menu button. */
export function hasNativeMenu(): boolean {
  const bridge = shellBridge();
  return Boolean(bridge && typeof bridge.openMenu === "function");
}

/** Tell the shell whether the session is usable; it only shows connection
 *  state while something is wrong, so a signed-in page clears the notice. */
export function reportNativeConnected(connected: boolean): void {
  const bridge = shellBridge();
  if (!bridge || typeof bridge.setConnected !== "function") return;
  try {
    bridge.setConnected(connected);
  } catch {
    // A destroyed WebView throws; the console itself keeps working.
  }
}

/** The shell pads its WebView for the system bars already, so the page must not
 *  add the safe-area inset a second time (it costs a header's height per side). */
export function clearNativeInsets(): void {
  if (!shellBridge()) return;
  const style = document.documentElement.style;
  style.setProperty("--safe-t", "0px");
  style.setProperty("--safe-b", "0px");
}

/** Ask the shell to open its menu (外观 / 刷新 / 连接记录). */
export function openNativeMenu(): void {
  const bridge = shellBridge();
  if (!bridge || typeof bridge.openMenu !== "function") return;
  try {
    bridge.openMenu();
  } catch {
    // A destroyed WebView throws; the console itself keeps working.
  }
}

/** The object name must match `addJavascriptInterface(..., "lubanShell")`. */
export function reportNativeStatus(status: NativeTaskStatus): void {
  const bridge = shellBridge();
  if (!bridge || typeof bridge.setTaskStatus !== "function") return;
  try {
    bridge.setTaskStatus(JSON.stringify(status));
  } catch {
    // A destroyed WebView throws; the console itself keeps working.
  }
}
