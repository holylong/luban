export type MediaKind = "video" | "audio" | "image";

const KINDS: Record<string, MediaKind> = {
  mp4: "video", m4v: "video", webm: "video", ogv: "video", mov: "video", mkv: "video", avi: "video",
  mp3: "audio", m4a: "audio", aac: "audio", wav: "audio", flac: "audio", ogg: "audio", oga: "audio", opus: "audio",
  png: "image", jpg: "image", jpeg: "image", gif: "image", webp: "image", avif: "image", bmp: "image", ico: "image",
};

/** Which viewer a path needs. The text reader refuses binary content, so media
 * files are played instead of being opened in the editor. */
export function mediaKind(path: string): MediaKind | null {
  const dot = path.lastIndexOf(".");
  const extension = dot < 0 ? "" : path.slice(dot + 1).toLowerCase();
  return KINDS[extension] ?? null;
}

/** `luban-media://workspace/<path>`: the desktop main process streams the file,
 * so a 4 MB editor limit never applies to media. */
export function mediaSource(path: string): string {
  return `luban-media://workspace/${path.split("/").filter(Boolean).map(encodeURIComponent).join("/")}`;
}
