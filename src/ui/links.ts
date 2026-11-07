/**
 * Clickable links in the output area.
 *
 * Links are painted as an underlined `label (url)` span, and enabling mouse
 * reporting means the terminal stops handling clicks itself: every press is
 * delivered to luban instead of reaching the terminal's own Ctrl+Click opener.
 * A link therefore only opens if the app resolves the URL under the pointer and
 * hands it to the desktop, which is what this module is for.
 */
import { spawn } from "node:child_process";
import { displayWidth } from "./input-layout.js";

/** Addresses as they show up in command output, docs and model answers. */
const URL_PATTERN = /https?:\/\/[^\s<>"'`\u001b]+/gu;
/** Punctuation that ends the sentence rather than the address. */
const TRAILING_PUNCTUATION = /[.,;:!?'"\]]+$/u;

/**
 * Strip what the sentence added to the address.
 *
 * A closing parenthesis is only dropped when the address has no matching
 * opening one, so a Wikipedia-style `/wiki/Foo_(bar)` URL stays intact.
 */
export function trimUrl(raw: string): string {
  let url = raw.replace(TRAILING_PUNCTUATION, "");
  while (url.endsWith(")")) {
    const open = url.match(/\(/gu)?.length ?? 0;
    const close = url.match(/\)/gu)?.length ?? 0;
    if (open >= close) break;
    url = url.slice(0, -1).replace(TRAILING_PUNCTUATION, "");
  }
  return url;
}

/**
 * The URL drawn at one display column of a physical transcript row.
 *
 * Columns are terminal cells, not string offsets: a row with Chinese text or an
 * emoji before the link shifts every following cell, so the offsets are summed
 * with `displayWidth` rather than `index`.
 */
export function findUrlAt(text: string, column: number): string | null {
  if (!text || !Number.isFinite(column) || column < 0) return null;
  for (const match of text.matchAll(URL_PATTERN)) {
    const url = trimUrl(match[0]);
    if (!url) continue;
    const start = displayWidth(text.slice(0, match.index));
    if (column < start) continue;
    if (column < start + displayWidth(url)) return url;
  }
  return null;
}

export interface OpenTarget {
  command: string;
  args: string[];
}

/**
 * The link a finished gesture should open.
 *
 * A press and a release on the same address is a click; anything else (a drag
 * that painted a selection, or a press that landed elsewhere) opens nothing.
 */
export function clickTarget(pressUrl: string | null, releaseUrl: string | null): string | null {
  return pressUrl && releaseUrl && pressUrl === releaseUrl ? pressUrl : null;
}

/**
 * The platform command that opens a URL in the user's browser.
 *
 * Only http(s) is accepted: the URL comes from model or command output, and
 * anything else could launch a local handler (`file:`, custom protocol schemes)
 * just by clicking a line of text.
 */
export function externalOpenTarget(url: string, platform: NodeJS.Platform = process.platform): OpenTarget | null {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return null;
  const href = parsed.toString();
  // `rundll32` rather than `cmd /c start`: cmd re-parses its arguments, so a
  // query string with `&` would be split into extra commands.
  if (platform === "win32") return { command: "rundll32", args: ["url.dll,FileProtocolHandler", href] };
  if (platform === "darwin") return { command: "open", args: [href] };
  return { command: "xdg-open", args: [href] };
}

/** Launch the browser for one URL; false when the platform or the spawn fails. */
export function openExternal(url: string, platform: NodeJS.Platform = process.platform): Promise<boolean> {
  const target = externalOpenTarget(url, platform);
  if (!target) return Promise.resolve(false);
  return new Promise((resolve) => {
    let settled = false;
    const done = (value: boolean): void => { if (!settled) { settled = true; resolve(value); } };
    try {
      const child = spawn(target.command, target.args, { stdio: "ignore", detached: true });
      child.on("error", () => done(false));
      // The opener hands the URL to the desktop and may stay alive; resolving on
      // spawn keeps the UI responsive instead of waiting for the browser.
      child.on("spawn", () => { done(true); child.unref(); });
    } catch {
      done(false);
    }
  });
}
