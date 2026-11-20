import { stripVTControlCharacters } from "node:util";

/** Erase-line / erase-down sequences Ink writes at the start of a repaint. */
const ERASE = ["\u001b[2K", "\u001b[J", "\u001b[0J"] as const;

interface FrameState { raw: string }

const states = new WeakMap<object, FrameState>();
const LIMIT = 200_000;

/**
 * The last frame Ink wrote to `stream`, rebuilt from the raw output tail.
 *
 * Ink starts every repaint by erasing the previous frame, but one `write()` is
 * not one frame: a repaint can arrive split across chunks, and a chunk can hold
 * the tail of the previous frame plus the start of the next. Reading the newest
 * chunk on its own therefore yields half a screen — which is how a test could
 * see a header without the composer below it, or a header still carrying the
 * welcome screen, depending on how the writer happened to be scheduled.
 *
 * Cutting the buffered tail at the final erase marker returns the frame body
 * that is currently on screen, whatever the chunk boundaries were.
 *
 * Assertions must stay away from the raw escape prefix: callers get text with
 * the control sequences already stripped.
 */
export function readFrame(stream: object, chunk: unknown): string {
  const state = states.get(stream) ?? { raw: "" };
  states.set(stream, state);
  state.raw = (state.raw + String(chunk)).slice(-LIMIT);
  let start = -1;
  let end = 0;
  for (const marker of ERASE) {
    const found = state.raw.lastIndexOf(marker);
    if (found > start) {
      start = found;
      end = found + marker.length;
    }
  }
  const body = start >= 0 ? state.raw.slice(end) : state.raw;
  return stripVTControlCharacters(body);
}
