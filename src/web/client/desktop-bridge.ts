export interface DesktopFile { path: string; content: string; revision: string }
export interface CommandEvent { id: string; kind: "output" | "exit"; text: string }
export interface TerminalStart { id: string; pty: boolean; cols: number; rows: number; shell: string }
export interface DesktopBridge {
  readFile(path: string): Promise<DesktopFile>;
  saveFile(input: DesktopFile): Promise<DesktopFile>;
  listFiles(): Promise<string[]>;
  runCommand(command: string): Promise<{ id: string }>;
  stopCommand(id: string): Promise<void>;
  startTerminal(input: { cols: number; rows: number }): Promise<TerminalStart>;
  writeTerminal(input: { id: string; data: string }): Promise<{ ok: boolean }>;
  stopTerminal(id: string): Promise<{ ok: boolean }>;
  setDirty(dirty: boolean): void;
  onCommandEvent(listener: (event: CommandEvent) => void): () => void;
}
declare global { interface Window { lubanDesktop?: DesktopBridge } }

export interface EditorDocument extends DesktopFile { saved: string; diskError?: string; conflict?: boolean }

/** Never advance the save revision while a local draft differs from disk. */
export function acceptDisk(document: EditorDocument, disk: DesktopFile): EditorDocument {
  if (disk.revision === document.revision) {
    return document.diskError || document.conflict ? { ...document, diskError: undefined, conflict: false } : document;
  }
  if (document.content === document.saved || document.content === disk.content) {
    return { ...disk, saved: disk.content };
  }
  return { ...document, conflict: true, diskError: undefined };
}
export function acceptSaved(document: EditorDocument, saved: DesktopFile): EditorDocument {
  return { ...document, revision: saved.revision, saved: saved.content };
}
export function quickMatches(files: string[], query: string): string[] {
  const terms = query.toLowerCase().trim().split(/\s+/).filter(Boolean);
  return files.filter(path => terms.every(term => path.toLowerCase().includes(term))).slice(0, 100);
}
