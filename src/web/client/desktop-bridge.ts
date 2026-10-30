export interface DesktopFile { path: string; content: string; revision: string }
export interface CommandEvent { id: string; kind: "output" | "exit"; text: string }
export interface DesktopBridge {
  readFile(path: string): Promise<DesktopFile>;
  saveFile(input: DesktopFile): Promise<DesktopFile>;
  listFiles(): Promise<string[]>;
  runCommand(command: string): Promise<{ id: string }>;
  stopCommand(id: string): Promise<void>;
  setDirty(dirty: boolean): void;
  onCommandEvent(listener: (event: CommandEvent) => void): () => void;
}
declare global { interface Window { lubanDesktop?: DesktopBridge } }

export interface EditorDocument extends DesktopFile { saved: string }
export function acceptSaved(document: EditorDocument, saved: DesktopFile): EditorDocument {
  return { ...document, revision: saved.revision, saved: saved.content };
}
export function quickMatches(files: string[], query: string): string[] {
  const terms = query.toLowerCase().trim().split(/\s+/).filter(Boolean);
  return files.filter(path => terms.every(term => path.toLowerCase().includes(term))).slice(0, 100);
}
