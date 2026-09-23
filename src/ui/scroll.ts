/**
 * Scroll model shared by the mouse wheel, PageUp/PageDown and the renderer.
 *
 * There is a single scroll position: everything the agent produced is one
 * ordered stream.
 *
 * Offsets are measured from the bottom of a list: `0` is the newest content and
 * `maxOffset` is the oldest. Every entry point clamps through here, because an
 * unclamped offset silently breaks scrolling: once `offset` grows past
 * `maxOffset` the view stops moving, yet the counter keeps rising, so scrolling
 * back down does nothing for the same number of notches (a rubber-band that
 * makes the wheel feel broken).
 */

export interface ListWindow {
  total: number;
  pageSize: number;
  /** Clamped scroll position: 0 shows the newest page, maxOffset the oldest. */
  offset: number;
  maxOffset: number;
  /** Inclusive index of the first visible item. */
  start: number;
  /** Exclusive index of the last visible item. */
  end: number;
  atTop: boolean;
  atBottom: boolean;
  scrollable: boolean;
}

export function listWindow(total: number, pageSize: number, offset: number): ListWindow {
  const count = Math.max(0, Math.trunc(total) || 0);
  const size = Math.max(1, Math.trunc(pageSize) || 1);
  const max = Math.max(0, count - size);
  const clamped = Math.min(Math.max(0, Math.trunc(offset) || 0), max);
  const end = count - clamped;
  const start = Math.max(0, end - size);
  return {
    total: count,
    pageSize: size,
    offset: clamped,
    maxOffset: max,
    start,
    end: Math.max(start, end),
    atTop: clamped >= max,
    atBottom: clamped <= 0,
    scrollable: max > 0,
  };
}

/** One block of a stream, measured in terminal lines. */
export interface SizedBlock { lines: number }

export interface StreamWindow extends ListWindow {
  /** First visible block index. */
  firstBlock: number;
  /** Exclusive last visible block index. */
  lastBlock: number;
}

/**
 * Window a single ordered stream of blocks.
 *
 * The window is computed in line space rather than item space so a long
 * message and a one-line tool result scroll at the same rate, and the reader
 * gets one continuous view instead of several independently paged panes.
 * Blocks that only partially overlap the viewport are included whole; the
 * caller's viewport clips the top, which is the least interesting edge.
 */
export function streamWindow(blocks: SizedBlock[], viewport: number, offset: number): StreamWindow {
  const heights = blocks.map(block => Math.max(1, Math.trunc(block.lines) || 1));
  const total = heights.reduce((sum, lines) => sum + lines, 0);
  const window = listWindow(total, viewport, offset);
  const endLine = window.end;
  let cursor = 0;
  let firstBlock = 0;
  let lastBlock = blocks.length;
  for (const [index, lines] of heights.entries()) {
    const start = cursor;
    cursor += lines;
    if (cursor <= window.start) firstBlock = index + 1;
    if (lastBlock === blocks.length && start >= endLine && endLine > 0) lastBlock = index;
  }
  if (firstBlock > lastBlock) firstBlock = lastBlock;
  return { ...window, firstBlock, lastBlock };
}

export interface ScrollbarThumb {
  /** First row of the thumb, 0-based from the top of the track. */
  start: number;
  size: number;
}

/** Thumb geometry for a vertical track of `height` rows. Null when nothing scrolls. */
export function scrollbarThumb(window: ListWindow, height: number): ScrollbarThumb | null {
  const track = Math.max(1, Math.trunc(height) || 1);
  if (!window.scrollable || track < 2) return null;
  const size = Math.max(1, Math.min(track, Math.round((window.pageSize / window.total) * track)));
  const maxStart = track - size;
  const fromTop = (window.maxOffset - window.offset) / window.maxOffset;
  return { start: Math.round(fromTop * maxStart), size };
}

/** Position in the list as a percentage from the top; 100 means the newest content. */
export function scrollPercent(window: ListWindow): number {
  if (!window.scrollable) return 100;
  return Math.round(((window.maxOffset - window.offset) / window.maxOffset) * 100);
}

export function scrollbarGlyph(top: boolean, bottom: boolean): string {
  if (top && bottom) return "█";
  if (top) return "▄";
  if (bottom) return "▀";
  return "█";
}
