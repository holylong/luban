import { describe, expect, it } from "vitest";
import { listWindow, scrollPercent, scrollbarThumb, streamWindow } from "./scroll.js";

const targets = (detailTotal: number, transcriptTotal: number, active = true): ScrollTargets => ({
  detail: { total: detailTotal, pageSize: 10, active },
  transcript: { total: transcriptTotal, pageSize: 4 },
});

describe("listWindow", () => {
  it("shows the newest page at offset 0 and the oldest page at maxOffset", () => {
    const bottom = listWindow(100, 10, 0);
    expect(bottom).toMatchObject({ offset: 0, maxOffset: 90, start: 90, end: 100, atBottom: true, atTop: false });
    const top = listWindow(100, 10, 90);
    expect(top).toMatchObject({ offset: 90, start: 0, end: 10, atTop: true, atBottom: false });
  });

  it("clamps an over-scrolled offset instead of remembering the overshoot", () => {
    // This is the rubber-band regression: without clamping, offset 500 would be
    // stored and 490 notches of scrolling back down would do nothing visible.
    const window = listWindow(100, 10, 500);
    expect(window.offset).toBe(90);
    expect(window.start).toBe(0);
    expect(window.end).toBe(10);
    expect(window.atTop).toBe(true);
  });

  it("treats a list shorter than the page as fully visible and not scrollable", () => {
    const window = listWindow(3, 10, 7);
    expect(window).toMatchObject({ offset: 0, maxOffset: 0, start: 0, end: 3, atTop: true, atBottom: true, scrollable: false });
  });

  it("handles empty and degenerate input", () => {
    expect(listWindow(0, 10, 5)).toMatchObject({ total: 0, start: 0, end: 0, scrollable: false });
    expect(listWindow(10, 0, 2)).toMatchObject({ pageSize: 1, offset: 2 });
    expect(listWindow(10, -4, -9)).toMatchObject({ pageSize: 1, offset: 0 });
  });
});

describe("streamWindow", () => {
  const blocks = (...heights: number[]): { lines: number }[] => heights.map(lines => ({ lines }));

  it("shows the whole stream when it fits", () => {
    const view = streamWindow(blocks(1, 2, 1), 20, 0);
    expect(view).toMatchObject({ firstBlock: 0, lastBlock: 3, total: 4, maxOffset: 0, atTop: true, atBottom: true, scrollable: false });
  });

  it("keeps the newest blocks at offset 0 and walks to the oldest", () => {
    // 10 blocks of 2 lines = 20 lines, viewport 6.
    const stream = blocks(...Array.from({ length: 10 }, () => 2));
    const bottom = streamWindow(stream, 6, 0);
    expect(bottom).toMatchObject({ offset: 0, maxOffset: 14, end: 20, start: 14, atBottom: true });
    expect(bottom.firstBlock).toBe(7);
    expect(bottom.lastBlock).toBe(10);

    const top = streamWindow(stream, 6, 14);
    expect(top).toMatchObject({ offset: 14, start: 0, end: 6, atTop: true });
    expect(top.firstBlock).toBe(0);
    expect(top.lastBlock).toBe(3);
  });

  it("clamps an over-scrolled offset so no notch is dead", () => {
    const stream = blocks(...Array.from({ length: 10 }, () => 2));
    const overshot = streamWindow(stream, 6, 500);
    expect(overshot.offset).toBe(14);
    expect(overshot.firstBlock).toBe(0);
    expect(streamWindow(stream, 6, 14)).toEqual(overshot);
  });

  it("uses line space, not block counts, so a tall block scrolls like many short ones", () => {
    const stream = blocks(40, 1, 1);
    // A viewport of two lines at the bottom must show exactly the two short
    // blocks, even though they are the 2nd and 3rd of only three blocks.
    const view = streamWindow(stream, 2, 0);
    expect(view.total).toBe(42);
    expect(view.start).toBe(40);
    expect(view.firstBlock).toBe(1);
    expect(view.lastBlock).toBe(3);
    // And one more line of viewport pulls in the tail of the tall block.
    expect(streamWindow(stream, 3, 0).firstBlock).toBe(0);
  });

  it("includes a block that only partially overlaps the viewport", () => {
    const view = streamWindow(blocks(5, 5, 5), 6, 0);
    // Lines 9..15 are visible: block 1 (5-10) and block 2 (10-15).
    expect(view.start).toBe(9);
    expect(view.end).toBe(15);
    expect(view.firstBlock).toBe(1);
    expect(view.lastBlock).toBe(3);
  });

  it("handles an empty stream", () => {
    expect(streamWindow([], 10, 3)).toMatchObject({ firstBlock: 0, lastBlock: 0, total: 0, scrollable: false });
  });
});

describe("scrollbarThumb", () => {
  it("puts the thumb at the bottom for the newest content and at the top for the oldest", () => {
    expect(scrollbarThumb(listWindow(100, 10, 0), 10)).toEqual({ start: 9, size: 1 });
    expect(scrollbarThumb(listWindow(100, 10, 90), 10)).toEqual({ start: 0, size: 1 });
  });

  it("sizes the thumb by the visible fraction", () => {
    expect(scrollbarThumb(listWindow(100, 50, 0), 10)).toEqual({ start: 5, size: 5 });
    expect(scrollbarThumb(listWindow(100, 25, 0), 20)).toEqual({ start: 15, size: 5 });
  });

  it("returns nothing when the list already fits", () => {
    expect(scrollbarThumb(listWindow(4, 10, 0), 10)).toBeNull();
    expect(scrollbarThumb(listWindow(100, 10, 0), 1)).toBeNull();
  });

  it("keeps the thumb inside the track at every position", () => {
    for (let offset = 0; offset <= 90; offset += 1) {
      const thumb = scrollbarThumb(listWindow(100, 10, offset), 12)!;
      expect(thumb.start).toBeGreaterThanOrEqual(0);
      expect(thumb.start + thumb.size).toBeLessThanOrEqual(12);
    }
  });
});

describe("scrollPercent", () => {
  it("reports 100 at the newest content and 0 at the oldest", () => {
    expect(scrollPercent(listWindow(100, 10, 0))).toBe(100);
    expect(scrollPercent(listWindow(100, 10, 90))).toBe(0);
    expect(scrollPercent(listWindow(100, 10, 45))).toBe(50);
  });

  it("reports 100 when there is nothing to scroll", () => {
    expect(scrollPercent(listWindow(3, 10, 0))).toBe(100);
  });
});
