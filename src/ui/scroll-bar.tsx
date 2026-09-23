import React from "react";
import { Box, Text } from "ink";
import { scrollbarThumb, type ListWindow } from "./scroll.js";
import { theme } from "./theme.js";

/** The slice of Ink's DOM node needed to locate a rendered element on screen. */
export interface LayoutNode {
  yogaNode?: { getComputedLayout(): { top: number; left: number } };
  parentNode?: LayoutNode;
}

/**
 * Absolute screen position of a rendered node, in zero-based cells from the
 * top-left of the terminal. Yoga reports each node relative to its parent, so
 * the ancestor chain has to be summed.
 */
export function absolutePosition(node: LayoutNode | null | undefined): { top: number; left: number } | null {
  if (!node?.yogaNode) return null;
  let top = 0;
  let left = 0;
  let current: LayoutNode | undefined = node;
  while (current) {
    const layout = current.yogaNode?.getComputedLayout?.();
    if (layout) {
      top += Number.isFinite(layout.top) ? layout.top : 0;
      left += Number.isFinite(layout.left) ? layout.left : 0;
    }
    current = current.parentNode;
  }
  return { top, left };
}

export interface ScrollBarProps {
  window: ListWindow;
  height: number;
  /** Receives the rendered node so the caller can hit-test the track. */
  measureRef?: (node: unknown) => void;
}

/**
 * Vertical scrollbar for the right edge of a pane.
 *
 * The track is always drawn so the affordance is visible even before there is
 * anything to scroll; the thumb appears once the list overflows and moves with
 * the clamped window, so its position always matches what is on screen.
 */
export function ScrollBar({ window: view, height, measureRef }: ScrollBarProps): React.ReactElement | null {
  const track = Math.max(1, Math.trunc(height) || 1);
  if (track < 2) return null;
  const thumb = scrollbarThumb(view, track);
  return (
    <Box
      ref={(node) => { measureRef?.(node); }}
      flexDirection="column"
      width={1}
      flexShrink={0}
      marginLeft={1}
      overflow="hidden"
    >
      {Array.from({ length: track }, (_, index) => {
        const filled = Boolean(thumb && index >= thumb.start && index < thumb.start + thumb.size);
        return <Text key={index} color={filled ? theme.accent : theme.dim}>{filled ? "█" : "│"}</Text>;
      })}
    </Box>
  );
}
