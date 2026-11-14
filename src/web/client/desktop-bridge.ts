import type { DocumentPreview } from "./desktop-preview";

export interface DesktopFile { path: string; content: string; revision: string }
export interface CommandEvent { id: string; kind: "output" | "exit"; text: string }
export interface TerminalStart { id: string; pty: boolean; cols: number; rows: number; shell: string }
export interface DesktopBridge {
  /** Only validated HTTP(S) URLs reach the OS browser. */
  openExternal?(url: string): Promise<{ ok: boolean }>;
  onPetJob?(listener: (id: string) => void): () => void;
  readFile(path: string): Promise<DesktopFile>;
  saveFile(input: DesktopFile): Promise<DesktopFile>;
  listFiles(): Promise<string[]>;
  /** Parsed slide deck or draw.io diagram; absent on bridges from older builds. */
  readPreview?(path: string): Promise<DocumentPreview>;
  /** Open a preview the workbench cannot paint in the OS application. */
  openPath?(path: string): Promise<{ ok: boolean }>;
  /** File-tree menu: show the entry in Finder/Explorer. */
  revealPath?(path: string): Promise<{ ok: boolean }>;
  /** File-tree menu: copy the absolute path to the system clipboard. */
  copyPath?(path: string): Promise<{ ok: boolean; path?: string }>;
  /** File-tree menu: create an empty file or folder. */
  createEntry?(input: { path: string; kind: "file" | "dir" }): Promise<{ ok?: boolean; path?: string; kind?: string }>;
  /** File-tree menu: rename inside the same folder. */
  renameEntry?(input: { from: string; to: string }): Promise<{ from?: string; to?: string }>;
  /** File-tree menu: move the entry to the trash after a native confirmation. */
  trashEntry?(path: string): Promise<{ ok: boolean; canceled?: boolean }>;
  /** Desktop mode only: pick a new project folder and restart the local backend there. */
  openWorkspace?(): Promise<{ canceled?: boolean; path?: string; mode?: "window" | "switch" }>;
  /** Desktop mode only: pick a folder and open it in a second window. */
  openWorkspaceWindow?(): Promise<{ canceled?: boolean; path?: string }>;
  /** Whether the floating Creator window is on screen; absent on older builds. */
  petVisible?(): Promise<boolean>;
  /** Show or hide the floating Creator window; resolves with the new state. */
  togglePet?(): Promise<boolean>;
  onPetVisibility?(listener: (visible: boolean) => void): () => void;
  runCommand(command: string): Promise<{ id: string }>;
  stopCommand(id: string): Promise<void>;
  startTerminal(input: { cols: number; rows: number }): Promise<TerminalStart>;
  writeTerminal(input: { id: string; data: string }): Promise<{ ok: boolean }>;
  /** Re-fit the pty after a drag; absent on bridges from older builds. */
  resizeTerminal?(input: { id: string; cols: number; rows: number }): Promise<{ ok: boolean; resized: boolean }>;
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
/** Electron wraps renderer-facing IPC failures as
 * "Error invoking remote method 'luban:readFile': Error: reason". Keep the
 * reason, and turn the expected refusals — size, encoding, binary content, a
 * deleted file — into a sentence the user can act on. */
export function desktopErrorText(cause: unknown, path?: string): string {
  const raw = cause instanceof Error ? cause.message : String(cause ?? "");
  const reason = raw.replace(/^Error invoking remote method '[^']*':\s*/, "").replace(/^Error:\s*/, "").trim();
  const label = path ?? "这个文件";
  const size = /exceeds ([\d.]+)\s*MB/i.exec(reason);
  if (size) return `${label} 超过 ${size[1]} MB，桌面编辑器不加载这么大的文件；请在终端或用其他编辑器查看。`;
  if (/binary files are not supported/i.test(reason)) return `${label} 是二进制内容（图片、压缩包或可执行文件），代码编辑器无法打开。`;
  if (/utf-?16/i.test(reason)) return `${label} 是 UTF-16 编码，请先另存为 UTF-8 再打开，避免保存时改动编码。`;
  if (/not valid utf-8/i.test(reason)) return `${label} 不是 UTF-8 文本，代码编辑器无法打开。`;
  if (/\bENOENT\b|no such file/i.test(reason)) return `${label} 已不存在，可能被删除或重命名。`;
  if (/\bEACCES\b|\bEPERM\b|permission denied/i.test(reason)) return `${label} 没有读取权限。`;
  if (/revision conflict|changed while opening|file changed/i.test(reason)) return `${label} 在磁盘上已被修改，本次保存没有写入；请先复制当前内容，再重新读取磁盘版本。`;
  return reason || "未知错误";
}
export function quickMatches(files: string[], query: string): string[] {
  const terms = query.toLowerCase().trim().split(/\s+/).filter(Boolean);
  return files.filter(path => terms.every(term => path.toLowerCase().includes(term))).slice(0, 100);
}
