export type MediaKind = "video" | "audio" | "image" | "pdf";

const KINDS: Record<string, MediaKind> = {
  mp4: "video", m4v: "video", webm: "video", ogv: "video", mov: "video", mkv: "video", avi: "video",
  mp3: "audio", m4a: "audio", aac: "audio", wav: "audio", flac: "audio", ogg: "audio", oga: "audio", opus: "audio",
  png: "image", jpg: "image", jpeg: "image", gif: "image", webp: "image", avif: "image", bmp: "image", ico: "image",
  pdf: "pdf",
};

/** Which viewer a path needs. The text reader refuses binary content, so media
 * files are played instead of being opened in the editor. */
export function mediaKind(path: string): MediaKind | null {
  const dot = path.lastIndexOf(".");
  const extension = dot < 0 ? "" : path.slice(dot + 1).toLowerCase();
  return KINDS[extension] ?? null;
}

export type DocumentPreviewKind = "slides" | "diagram" | "sheet" | "word";

const DOCUMENTS: Record<string, DocumentPreviewKind> = {
  pptx: "slides", pptm: "slides", ppsx: "slides",
  drawio: "diagram", dio: "diagram",
  xlsx: "sheet", xlsm: "sheet", xltx: "sheet", xls: "sheet",
  docx: "word", docm: "word", doc: "word",
};

/** Office documents and draw.io diagrams are parsed by the desktop main process
 * and rendered as read-only previews instead of text. */
export function documentPreviewKind(path: string): DocumentPreviewKind | null {
  const lower = path.toLowerCase();
  if (lower.endsWith(".drawio.svg") || lower.endsWith(".drawio.png") || lower.endsWith(".drawio.xml")) return "diagram";
  const dot = lower.lastIndexOf(".");
  return DOCUMENTS[dot < 0 ? "" : lower.slice(dot + 1)] ?? null;
}

/** `luban-media://workspace/<path>`: the desktop main process streams the file,
 * so a 4 MB editor limit never applies to media. */
export function mediaSource(path: string): string {
  return `luban-media://workspace/${path.split("/").filter(Boolean).map(encodeURIComponent).join("/")}`;
}

/** An image inside a deck: the main process reads the zip entry on demand. */
export function mediaEntrySource(path: string, entry: string): string {
  return `${mediaSource(path)}?entry=${encodeURIComponent(entry)}`;
}
