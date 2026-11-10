import React, { useRef } from "react";

/** A draggable divider between two panes.
 *
 *  The drag reports an absolute size — "the pane was 420px when the drag
 *  started, the pointer moved 40px" — instead of an incremental delta. React
 *  batches pointer events, so a delta applied to the previous render's value
 *  silently dropped every move but the last one: the handle looked stuck.
 */
export function PaneSplitter({ orientation, label, value, sign = 1, onResize }: {
  orientation: "vertical" | "horizontal";
  label: string;
  /** Pane size in px at the moment the drag starts. */
  value: number;
  /** +1 when the pane sits before the handle, -1 when it sits after it. */
  sign?: number;
  onResize(next: number): void;
}): React.ReactElement {
  const drag = useRef<{ pointer: number; value: number } | undefined>(undefined);
  const position = (event: React.PointerEvent<HTMLDivElement>): number =>
    orientation === "vertical" ? event.clientX : event.clientY;
  const start = (event: React.PointerEvent<HTMLDivElement>): void => {
    event.preventDefault();
    drag.current = { pointer: position(event), value };
    event.currentTarget.setPointerCapture(event.pointerId);
    document.body.classList.add("desktop-dragging-pane");
  };
  const move = (event: React.PointerEvent<HTMLDivElement>): void => {
    const state = drag.current;
    if (!state) return;
    const delta = position(event) - state.pointer;
    if (!delta) return;
    onResize(state.value + delta * sign);
  };
  const finish = (event: React.PointerEvent<HTMLDivElement>): void => {
    drag.current = undefined;
    document.body.classList.remove("desktop-dragging-pane");
    if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
  };
  const key = (event: React.KeyboardEvent<HTMLDivElement>): void => {
    const [back, forward] = orientation === "vertical" ? ["ArrowLeft", "ArrowRight"] : ["ArrowUp", "ArrowDown"];
    if (event.key !== back && event.key !== forward) return;
    event.preventDefault();
    onResize(value + (event.key === forward ? 24 : -24) * sign);
  };
  return <div
    className={`desktop-splitter ${orientation}`}
    role="separator"
    aria-orientation={orientation}
    aria-label={label}
    aria-valuenow={Math.round(value)}
    title={`${label}（拖动或用方向键）`}
    tabIndex={0}
    onPointerDown={start}
    onPointerMove={move}
    onPointerUp={finish}
    onPointerCancel={finish}
    onKeyDown={key}
  />;
}
