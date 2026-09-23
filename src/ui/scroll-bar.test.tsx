import React from "react";
import { renderToString } from "ink";
import { describe, expect, it } from "vitest";
import { absolutePosition, ScrollBar } from "./scroll-bar.js";
import { listWindow } from "./scroll.js";

describe("side scrollbar", () => {
  it("always draws a track so the affordance is visible", () => {
    const output = renderToString(<ScrollBar window={listWindow(3, 10, 0)} height={6} />, { columns: 1 });
    expect(output).toContain("│");
    expect(output).not.toContain("█");
  });

  it("draws a thumb once the list overflows", () => {
    const output = renderToString(<ScrollBar window={listWindow(100, 10, 0)} height={6} />, { columns: 1 });
    expect(output).toContain("█");
    expect(output).toContain("│");
  });

  it("moves the thumb to the top when scrolled to the oldest entry", () => {
    const height = 6;
    const newest = renderToString(<ScrollBar window={listWindow(100, 10, 0)} height={height} />, { columns: 1 });
    const oldest = renderToString(<ScrollBar window={listWindow(100, 10, 90)} height={height} />, { columns: 1 });
    expect(newest).not.toBe(oldest);
    // Newest content puts the thumb on the last row, oldest on the first.
    expect(newest.split("\n").filter(Boolean).at(-1)).toContain("█");
    expect(oldest.split("\n").filter(Boolean)[0]).toContain("█");
  });

  it("renders nothing for a track too short to be meaningful", () => {
    expect(renderToString(<ScrollBar window={listWindow(100, 10, 0)} height={1} />, { columns: 1 })).toBe("");
  });
});

describe("absolutePosition", () => {
  const node = (top: number, left: number, parent?: unknown) => ({
    yogaNode: { getComputedLayout: () => ({ top, left }) },
    parentNode: parent,
  });

  it("sums the ancestor chain, since yoga reports each node relative to its parent", () => {
    const root = node(0, 0);
    const row = node(3, 2, root);
    const bar = node(0, 40, row);
    expect(absolutePosition(bar)).toEqual({ top: 3, left: 42 });
  });

  it("returns null when the node has no layout yet", () => {
    expect(absolutePosition(null)).toBeNull();
    expect(absolutePosition({})).toBeNull();
  });
});
