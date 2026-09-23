import { readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import type { AttachedImage, ChatMessage, ToolDefinition } from "./types.js";
import { resolveInside } from "./paths.js";
import { relative, resolve, sep } from "node:path";

/** Rough budget placeholder so image-bearing turns still compact predictably. */
export const IMAGE_TOKEN_COST = 1200;
export const MAX_IMAGE_BYTES = 8_000_000;

const MIME_BY_EXTENSION: Array<[RegExp, string]> = [
  [/\.png$/i, "image/png"],
  [/\.jpe?g$/i, "image/jpeg"],
  [/\.gif$/i, "image/gif"],
  [/\.webp$/i, "image/webp"],
  [/\.bmp$/i, "image/bmp"],
  [/\.avif$/i, "image/avif"],
];

export function mimeOfImagePath(path: string): string | null {
  for (const [pattern, mime] of MIME_BY_EXTENSION) if (pattern.test(path)) return mime;
  return null;
}

export function isImagePath(path: string): boolean {
  return mimeOfImagePath(path) !== null;
}

export function toAttachedImage(path: string): AttachedImage | null {
  const mime = mimeOfImagePath(path);
  return mime ? { path, mime } : null;
}

export interface ResolvedImage { mime: string; base64: string; path: string }

/** Read attached image bytes fresh from the workspace; skips unreadable files. */
export async function resolveImageParts(workspace: string, images: AttachedImage[] | undefined): Promise<ResolvedImage[]> {
  if (!images?.length) return [];
  const out: ResolvedImage[] = [];
  for (const image of images.slice(0, 8)) {
    if (!image?.path || !image.mime) continue;
    // Defense in depth: never follow absolute paths or escapes; the TUI only
    // attaches workspace-relative @ mentions.
    if (image.path.startsWith("/") || image.path.includes("..")) continue;
    try {
      const abs = join(workspace, image.path);
      const info = await stat(abs);
      if (!info.isFile() || info.size > MAX_IMAGE_BYTES) continue;
      const base64 = (await readFile(abs)).toString("base64");
      out.push({ mime: image.mime, base64, path: image.path });
    } catch {
      // Dropped attachments are reported by the caller via remaining text.
    }
  }
  return out;
}

/** Model-initiated vision: appends to the latest user message in place, so no
 * tool-call pairing is disturbed and the next model turn carries the bytes. */
export function attachImageTools(messages: ChatMessage[], workspace: string): ToolDefinition[] {
  return [{
    name: "attach_image",
    description: "Attach a workspace image to the current request so a vision-capable model can see it. Use after read_image or when the user references a screenshot. Bytes are sent natively on the next model call.",
    risk: "read",
    parameters: {
      type: "object", additionalProperties: false, required: ["path"],
      properties: { path: { type: "string", description: "Workspace-relative image path" } },
    },
    async execute(args, signal) {
      signal.throwIfAborted();
      if (typeof args.path !== "string" || !args.path.trim()) throw new Error("path must be a string");
      const abs = await resolveInside(workspace, args.path);
      const rel = relative(resolve(workspace), abs).split(sep).join("/");
      const attached = toAttachedImage(rel);
      if (!attached) throw new Error("attach_image supports png/jpg/gif/webp/bmp/avif");
      const info = await stat(abs);
      if (!info.isFile() || info.size > MAX_IMAGE_BYTES) throw new Error(`image is too large (${info.size} bytes, max 8 MB)`);
      const target = [...messages].reverse().find((message) => message.role === "user");
      if (!target) throw new Error("no user message to attach to");
      target.images = [...(target.images ?? [])];
      if (!target.images.some((item) => item.path === rel)) target.images.push(attached);
      if (target.images.length > 8) target.images = target.images.slice(-8);
      return `attached ${rel} (${attached.mime}, ${info.size} bytes) to the current request; it will be sent as a native vision part on the next model call`;
    },
  }];
}
