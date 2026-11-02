import { acceptDisk, type DesktopFile, type EditorDocument } from "./desktop-bridge";

/** Poll only open tabs; serialize reads, discard stale responses, and clean up on unmount. */
export function startFileSync(options: {
  readFile(path: string): Promise<DesktopFile>;
  documents(): EditorDocument[];
  saving(): boolean;
  update(change: (documents: EditorDocument[]) => EditorDocument[]): void;
  target: Pick<Window, "addEventListener" | "removeEventListener">;
  intervalMs?: number;
}): () => void {
  let stopped = false;
  let busy = false;
  const refresh = async (): Promise<void> => {
    if (stopped || busy || options.saving()) return;
    busy = true;
    try {
      for (const snapshot of options.documents()) {
        if (stopped || options.saving()) break;
        let disk: DesktopFile | undefined;
        let error: string | undefined;
        try { disk = await options.readFile(snapshot.path); }
        catch (cause) { error = String(cause); }
        if (stopped || options.saving()) continue;
        options.update(current => current.map(item => {
          // Closing/reopening or saving a tab invalidates this read. Typing does
          // not: reconcile against the latest buffer, not the request snapshot.
          if (item.path !== snapshot.path || item.revision !== snapshot.revision || item.saved !== snapshot.saved) return item;
          return disk ? acceptDisk(item, disk) : { ...item, diskError: error };
        }));
      }
    } finally { busy = false; }
  };
  const focus = (): void => { void refresh(); };
  const timer = setInterval(focus, options.intervalMs ?? 1000);
  options.target.addEventListener("focus", focus);
  focus();
  return () => {
    stopped = true;
    clearInterval(timer);
    options.target.removeEventListener("focus", focus);
  };
}
