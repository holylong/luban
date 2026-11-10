import React, { useRef } from "react";

/**
 * A drag handle between two panes. It reports incremental pointer deltas and
 * lets the caller clamp, so a drag can never collapse the code column; arrow
 * keys move the same edge for keyboard users.
 */
export function PaneSplitter({ orientation, label, onDelta }: {
  orientation: "vertical" | "horizontal";
  label: string;
  onDelta(delta: number): void;
}): React.ReactElement {
  const dragging = useRef<number | undefined>(undefined);
  const start = (event: React.PointerEvent<HTMLDivElement>): void => {
    event.preventDefault();
    dragging.current = orientation === "vertical" ? event.clientX : event.clientY;
    event.currentTarget.setPointerCapture(event.pointerId);
    document.body.classList.add("desktop-dragging-pane");
  };
  const move = (event: React.PointerEvent<HTMLDivElement>): void => {
    if (dragging.current === undefined) return;
    const position = orientation === "vertical" ? event.clientX : event.clientY;
    const delta = position - dragging.current;
    if (!delta) return;
    dragging.current = position;
    onDelta(delta);
  };
  const finish = (event: React.PointerEvent<HTMLDivElement>): void => {
    dragging.current = undefined;
    document.body.classList.remove("desktop-dragging-pane");
    if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
  };
  const key = (event: React.KeyboardEvent<HTMLDivElement>): void => {
    const [back, forward] = orientation === "vertical" ? ["ArrowLeft", "ArrowRight"] : ["ArrowUp", "ArrowDown"];
    if (event.key !== back && event.key !== forward) return;
    event.preventDefault();
    onDelta(event.key === back ? -24 : 24);
  };
  return <div
    className={`desktop-splitter ${orientation}`}
    role="separator"
    aria-orientation={orientation}
    aria-label={label}
    title={`${label}（拖动或用方向键）`}
    tabIndex={0}
    onPointerDown={start}
    onPointerMove={move}
    onPointerUp={finish}
    onPointerCancel={finish}
    onKeyDown={key}
  />;
}
