import React, { useRef, useState } from "react";
import { Box, Text, useInput } from "ink";
import { displayWidth, layoutInput, normalizeInsert, offsetAtCell, offsetAtColumn, stepCursor } from "./input-layout.js";
import type { MouseInputGuard } from "./mouse-input.js";
import { theme } from "./theme.js";

export interface TextAreaProps {
  value: string;
  onChange: (value: string) => void;
  onSubmit: (value: string) => void;
  focus: boolean;
  placeholder: string;
  /** Columns available to the text itself. */
  width: number;
  /** Maximum rows drawn before the box scrolls to keep the cursor visible. */
  maxRows: number;
  /**
   * Drops mouse reports before they become text. Terminals that ignore ?1006
   * report in the older encodings, and Ink hands those payloads over as if
   * they had been typed.
   */
  mouseGuard?: MouseInputGuard;
  /**
   * A click inside the box asking for the caret, in cells relative to the box.
   * The nonce makes two clicks on the same cell distinct requests.
   */
  caret?: { row: number; column: number; nonce: number } | null;
  /** Receives the rendered box so the caller can hit-test a click against it. */
  measureRef?: (node: unknown) => void;
}

/**
 * A bounded, scrollable multi-line prompt box.
 *
 * Up/down move the cursor while the value spans several lines; the caller keeps
 * history recall for the single-line case and skips it when the value is
 * multi-line, so the two never fight over the same key.
 */
export function TextArea({ value, onChange, onSubmit, focus, placeholder, width, maxRows, mouseGuard, caret, measureRef }: TextAreaProps): React.ReactElement {
  // Ink refreshes useInput listeners in an effect, after the new frame is visible.
  // A key arriving in that gap must still submit with the current run/view state.
  const settingsRef = useRef({ onChange, onSubmit, focus, width, maxRows, mouseGuard });
  settingsRef.current = { onChange, onSubmit, focus, width, maxRows, mouseGuard };
  const cursorRef = useRef(value.length);
  const lastValueRef = useRef(value);
  const caretNonceRef = useRef(0);
  const [, tick] = useState(0);

  // A value replaced from outside (history recall, completion, reset) has no
  // meaningful stored cursor, so put it at the end.
  if (value !== lastValueRef.current) {
    lastValueRef.current = value;
    cursorRef.current = value.length;
  }

  // A click into the box moves the caret to the clicked cell. The rows are
  // measured against the frame that is on screen right now, so clicking the
  // last visible row cannot shift the window out from under the pointer.
  if (caret && caret.nonce !== caretNonceRef.current) {
    caretNonceRef.current = caret.nonce;
    cursorRef.current = offsetAtCell(value, cursorRef.current, width, maxRows, caret.row, caret.column);
  }

  const update = (next: string, cursor: number): void => {
    cursorRef.current = Math.max(0, Math.min(cursor, next.length));
    lastValueRef.current = next;
    settingsRef.current.onChange(next);
    tick((current) => current + 1);
  };

  const layout = layoutInput(value, cursorRef.current, width, maxRows);

  const insert = (text: string): void => {
    // Reports are dropped before normalization: to every other layer their
    // payload is plain text, and an X10 report's coordinates are not even that.
    const clean = normalizeInsert(settingsRef.current.mouseGuard?.filter(text) ?? text);
    if (!clean) return;
    const cursor = cursorRef.current;
    const value = lastValueRef.current;
    update(`${value.slice(0, cursor)}${clean}${value.slice(cursor)}`, cursor + clean.length);
  };

  useInput((input, key) => {
    const { focus, width, maxRows, onSubmit } = settingsRef.current;
    if (!focus) return;
    const value = lastValueRef.current;
    const layout = layoutInput(value, cursorRef.current, width, maxRows);
    const multiline = layout.total > 1;
    if (key.tab || (key.shift && key.tab)) return;
    if (key.ctrl && input === "c") return;
    // History recall owns the arrows for a single-line value.
    if (key.upArrow || key.downArrow) {
      if (!multiline) return;
      const target = layout.cursorRow + (key.upArrow ? -1 : 1);
      if (target < 0 || target >= layout.total) return;
      const row = layout.rows[target]!;
      const column = displayWidth(layout.rows[layout.cursorRow]!.text.slice(0, layout.cursorColumn));
      update(value, row.start + offsetAtColumn(row.text, column));
      return;
    }
    if (key.return) {
      // Enter (\r) submits; Shift+Enter inserts a break. Ctrl+J arrives as a
      // bare linefeed with no modifier flag, so the generic insert below
      // handles it — this branch must not claim to.
      if (key.shift) { insert("\n"); return; }
      onSubmit(value);
      return;
    }
    if (key.leftArrow) { update(value, stepCursor(value, cursorRef.current, -1)); return; }
    if (key.rightArrow) { update(value, stepCursor(value, cursorRef.current, 1)); return; }
    if (key.home) { update(value, layout.rows[layout.cursorRow]!.start); return; }
    if (key.end) { const row = layout.rows[layout.cursorRow]!; update(value, row.start + row.text.length); return; }
    if (key.backspace || key.delete) {
      // Both keys delete backwards, deliberately.
      //
      // Ink maps the byte almost every terminal sends for Backspace (\x7f) to
      // `key.delete`, and maps the real Delete key (ESC [ 3 ~) to the same
      // flag with an empty `input` and `meta: false` — there is no field that
      // tells them apart. Reading `key.delete` as "delete forwards" therefore
      // made Backspace do nothing at the end of the line, which is the bug
      // this branch exists to prevent. Losing forward-delete in a prompt box
      // is a far smaller cost than a dead Backspace key.
      const cursor = cursorRef.current;
      if (cursor === 0) return;
      const previous = stepCursor(value, cursor, -1);
      update(value.slice(0, previous) + value.slice(cursor), previous);
      return;
    }
    if (key.ctrl && input === "a") { update(value, 0); return; }
    if (key.ctrl && input === "e") { update(value, value.length); return; }
    if (key.ctrl && input === "u") { update(value.slice(cursorRef.current), 0); return; }
    if (key.ctrl || key.meta || key.escape || key.pageUp || key.pageDown) return;
    if (input) insert(input);
  }, { isActive: focus });

  if (value.length === 0) {
    // An empty box used to render only the placeholder, so there was nothing
    // to say where the caret was or whether the box had focus at all.
    return (
      <Box ref={(node) => { measureRef?.(node); }} flexGrow={1} overflow="hidden">
        {focus ? <Text backgroundColor={theme.accent} color={theme.background}> </Text> : null}
        <Text color={theme.dim}>{placeholder}</Text>
      </Box>
    );
  }

  return (
    <Box ref={(node) => { measureRef?.(node); }} flexDirection="column" flexGrow={1} overflow="hidden">
      {layout.rows.slice(layout.first, layout.last).map((row, index) => {
        const absolute = layout.first + index;
        const isCursorRow = absolute === layout.cursorRow;
        const column = isCursorRow && focus ? layout.cursorColumn : -1;
        const next = column < 0 ? -1 : stepCursor(row.text, column, 1);
        return (
          <Text key={absolute}>
            <Text color={theme.primary}>{column < 0 ? row.text : row.text.slice(0, column)}</Text>
            {column >= 0
              // A solid accent cell instead of `inverse`: reverse video is
              // nearly invisible on some terminals and on a one-space caret it
              // was impossible to spot.
              ? <Text backgroundColor={theme.accent} color={theme.background}>{next > column ? row.text.slice(column, next) : " "}</Text>
              : null}
            {column >= 0 ? <Text color={theme.primary}>{row.text.slice(next)}</Text> : null}
          </Text>
        );
      })}
    </Box>
  );
}
