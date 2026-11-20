/**
 * What to do when the renderer or the GPU process dies.
 *
 * A dead renderer leaves the BrowserWindow painting its own background colour:
 * the window still exists, so the tray keeps it, and all the user sees is a
 * black board until they close and reopen it. Rebuilding the window is exactly
 * what closing and reopening does; the backend and the workspace service stay
 * alive, so the conversation is still there afterwards.
 *
 * Reloading in place is not enough: a crashed compositor can keep the surface
 * black even after `webContents.reload()`, so recovery always destroys the
 * window and builds a new one.
 *
 * Crashing twice the same way means the remedy is not the problem, so the
 * policy escalates: a renderer crash loop restarts the app, and a second GPU
 * crash restarts it with hardware acceleration off — the fallback for a wedged
 * Metal context on macOS.
 */

const DEFAULTS = { windowMs: 5 * 60_000, maxRendererCrashes: 3, maxGpuCrashes: 2 };

function createRecoveryPolicy(options = {}) {
  const windowMs = options.windowMs ?? DEFAULTS.windowMs;
  const maxRendererCrashes = options.maxRendererCrashes ?? DEFAULTS.maxRendererCrashes;
  const maxGpuCrashes = options.maxGpuCrashes ?? DEFAULTS.maxGpuCrashes;
  const now = options.now ?? Date.now;
  const crashes = new Map();
  let gpuCrashes = [];

  const recent = list => {
    const floor = now() - windowMs;
    return list.filter(at => at > floor);
  };
  const record = (key, list) => {
    const kept = recent(list);
    kept.push(now());
    crashes.set(key, kept);
    return kept;
  };

  return {
    /**
     * One crash of the window's renderer. Only crashes inside the window count,
     * so a window that runs for hours between crashes still recovers in place.
     */
    rendererGone(key) {
      const count = record(`renderer:${key}`, crashes.get(`renderer:${key}`) ?? []).length;
      return count >= maxRendererCrashes ? "relaunch-app" : "recover-window";
    },
    /**
     * The renderer stopped answering (a long synchronous loop, a stalled GPU
     * readback). Rebuilding is safe — the backend holds the state — but a window
     * that keeps wedging is the same dead end as a window that keeps crashing,
     * so it escalates to a restart at the same threshold.
     */
    unresponsive(key) {
      const count = record(`unresponsive:${key}`, crashes.get(`unresponsive:${key}`) ?? []).length;
      return count >= maxRendererCrashes ? "relaunch-app" : "recover-window";
    },
    /**
     * The GPU process died. Without acceleration Chromium falls back to the
     * software compositor, which is slower but does not wedge the window.
     */
    gpuGone() {
      gpuCrashes = recent(gpuCrashes);
      gpuCrashes.push(now());
      return gpuCrashes.length >= maxGpuCrashes ? "relaunch-without-gpu" : "recover-window";
    },
    /** Crash history for one window, used by the log line. */
    count(key, kind = "renderer") {
      return recent(crashes.get(`${kind}:${key}`) ?? []).length;
    },
  };
}

module.exports = { createRecoveryPolicy, DEFAULTS };
