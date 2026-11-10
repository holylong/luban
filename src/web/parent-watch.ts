/**
 * End a headless backend when the process that started it goes away.
 *
 * The desktop app owns each window's local server: without the UI the server is
 * only a ghost that keeps polling the relay. The relay then lists the same
 * machine once per dead window, and because every instance shares the job
 * directory the phone shows the same task on every one of those cards.
 *
 * Electron passes its pid as `--parent-pid`. A child whose parent exits is
 * re-parented (its ppid changes, typically to 1), which is what we observe:
 * watching ppid avoids both signals and pid-reuse mistakes.
 */
export interface ParentWatchOptions {
  /** Injectable so a test needs no real processes. */
  ppid?: () => number;
  /** Injectable so a test can observe the decision instead of exiting. */
  exit?: (code: number) => void;
  intervalMs?: number;
  onParentGone?: () => void;
}

export function watchParent(pid: number, options: ParentWatchOptions = {}): () => void {
  const ppid = options.ppid ?? (() => process.ppid);
  const exit = options.exit ?? ((code: number) => { process.exit(code); });
  // A pid that is not our parent now (a shell wrapper, a detached run) must not
  // be watched: it would fire immediately and kill a perfectly good server.
  if (!Number.isFinite(pid) || pid <= 0 || ppid() !== pid) return () => undefined;
  const intervalMs = Math.max(50, options.intervalMs ?? 1000);
  const timer = setInterval(() => {
    if (ppid() === pid) return;
    clearInterval(timer);
    options.onParentGone?.();
    exit(0);
  }, intervalMs);
  timer.unref?.();
  return () => clearInterval(timer);
}
