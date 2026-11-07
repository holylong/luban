import { readFile, stat } from "node:fs/promises";
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

export class InvalidImageError extends Error {}

/** Validate the declared format before forwarding bytes to a model gateway. */
export function validateImageBytes(bytes: Buffer, mime: string, path: string): void {
  const png = Buffer.from("89504e470d0a1a0a", "hex");
  const valid = mime === "image/png" ? bytes.subarray(0, 8).equals(png)
    : mime === "image/jpeg" ? bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff
    : mime === "image/gif" ? /^(GIF87a|GIF89a)$/.test(bytes.subarray(0, 6).toString("ascii"))
    : mime === "image/webp" ? bytes.subarray(0, 4).toString() === "RIFF" && bytes.subarray(8, 12).toString() === "WEBP"
    : mime === "image/bmp" ? bytes.subarray(0, 2).toString() === "BM"
    : mime === "image/avif" ? bytes.subarray(4, 8).toString() === "ftyp" && /avif|avis/.test(bytes.subarray(8, 32).toString("ascii"))
    : false;
  if (valid) return;
  const offset = bytes.indexOf(png);
  const hint = offset > 0
    ? ` PNG signature is at byte ${offset}, not byte 0; screenshot warnings or shell redirection may have polluted the file. Capture binary output separately from stderr (for Android, use adb shell screencap -p /sdcard/shot.png then adb pull).`
    : " File bytes do not match the declared image format; recapture or export a valid image.";
  throw new InvalidImageError(`Invalid image ${path} (${mime}).${hint}`);
}

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
      const abs = await resolveInside(workspace, image.path);
      const info = await stat(abs);
      if (!info.isFile() || info.size > MAX_IMAGE_BYTES) continue;
      const bytes = await readFile(abs);
      validateImageBytes(bytes, image.mime, image.path);
      const base64 = bytes.toString("base64");
      out.push({ mime: image.mime, base64, path: image.path });
    } catch (error) {
      if (error instanceof InvalidImageError) throw error;
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
      validateImageBytes(await readFile(abs), attached.mime, rel);
      const target = [...messages].reverse().find((message) => message.role === "user");
      if (!target) throw new Error("no user message to attach to");
      target.images = [...(target.images ?? [])];
      if (!target.images.some((item) => item.path === rel)) target.images.push(attached);
      if (target.images.length > 8) target.images = target.images.slice(-8);
      return `attached ${rel} (${attached.mime}, ${info.size} bytes) to the current request; it will be sent as a native vision part on the next model call`;
    },
  }];
}
