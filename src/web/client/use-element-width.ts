import { useEffect, useRef, useState } from "react";
import type { RefObject } from "react";

/**
 * Live width of an element in CSS pixels, 0 until it has been measured.
 *
 * Server rendering and the first paint have no layout, so callers must decide
 * for 0 explicitly instead of treating it as "the narrowest possible pane".
 */
export function useElementWidth<T extends HTMLElement>(): readonly [RefObject<T | null>, number] {
  const ref = useRef<T | null>(null);
  const [width, setWidth] = useState(0);
  useEffect(() => {
    const element = ref.current;
    if (!element) return;
    const read = (next: number | undefined): void => {
      if (typeof next === "number" && next > 0) setWidth(next);
    };
    read(element.clientWidth);
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(entries => read(entries[0]?.contentRect.width));
    observer.observe(element);
    return () => observer.disconnect();
  }, []);
  return [ref, width] as const;
}
