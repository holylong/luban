import { describe, expect, it } from "vitest";
import { displayWidth, layoutInput, normalizeInsert, offsetAtCell, stepCursor } from "./input-layout.js";

describe("layoutInput", () => {
  it("keeps a short single-line value on one row", () => {
    const layout = layoutInput("hello", 5, 20, 4);
    expect(layout.total).toBe(1);
    expect(layout.rows[0]!.text).toBe("hello");
    expect(layout).toMatchObject({ cursorRow: 0, cursorColumn: 5, first: 0, last: 1, hiddenAbove: 0, hiddenBelow: 0 });
  });

  it("splits pasted text into one row per line", () => {
    const layout = layoutInput("one\ntwo\nthree", 0, 20, 10);
    expect(layout.rows.map(row => row.text)).toEqual(["one", "two", "three"]);
    expect(layout.rows.map(row => row.start)).toEqual([0, 4, 8]);
  });

  it("keeps an empty trailing row so a trailing newline is visible", () => {
    const layout = layoutInput("one\n", 4, 20, 10);
    expect(layout.rows.map(row => row.text)).toEqual(["one", ""]);
    expect(layout).toMatchObject({ cursorRow: 1, cursorColumn: 0 });
  });

  it("wraps long lines and counts wide characters as two columns", () => {
    expect(layoutInput("abcdefghij", 0, 4, 10).rows.map(row => row.text)).toEqual(["abcd", "efgh", "ij"]);
    // Four CJK characters fill an eight column row exactly.
    expect(layoutInput("中文中文a", 0, 8, 10).rows.map(row => row.text)).toEqual(["中文中文", "a"]);
  });

  it("scrolls the window to keep the cursor row visible", () => {
    const value = Array.from({ length: 30 }, (_, index) => `line-${index}`).join("\n");
    const atEnd = layoutInput(value, value.length, 40, 5);
    expect(atEnd.total).toBe(30);
    expect(atEnd.cursorRow).toBe(29);
    expect(atEnd).toMatchObject({ first: 25, last: 30, hiddenAbove: 25, hiddenBelow: 0 });

    const atStart = layoutInput(value, 0, 40, 5);
    expect(atStart).toMatchObject({ first: 0, last: 5, hiddenAbove: 0, hiddenBelow: 25 });
  });

  it("never hides the cursor row, however long the value", () => {
    const value = Array.from({ length: 200 }, (_, index) => `line-${index}`).join("\n");
    for (const cursor of [0, 5, 100, 500, 1000, value.length]) {
      const layout = layoutInput(value, Math.min(cursor, value.length), 40, 6);
      expect(layout.cursorRow).toBeGreaterThanOrEqual(layout.first);
      expect(layout.cursorRow).toBeLessThan(layout.last);
      expect(layout.last - layout.first).toBeLessThanOrEqual(6);
    }
  });

  it("clamps a cursor that is out of range", () => {
    expect(layoutInput("abc", 99, 20, 4).cursorColumn).toBe(3);
    expect(layoutInput("abc", -5, 20, 4).cursorColumn).toBe(0);
  });

  it("treats a zero-width layout as a single column so it cannot loop", () => {
    expect(layoutInput("abc", 0, 0, 0).rows.map(row => row.text)).toEqual(["a", "b", "c"]);
  });
});

describe("normalizeInsert", () => {
  it("unifies line endings so one paste is one edit", () => {
    expect(normalizeInsert("a\r\nb\rc\nd")).toBe("a\nb\nc\nd");
  });

  it("expands tabs so cursor columns match character offsets", () => {
    expect(normalizeInsert("a\tb")).toBe("a    b");
  });

  it("drops control characters that would corrupt the box", () => {
    expect(normalizeInsert("a\u0007b\u001bc")).toBe("abc");
    expect(normalizeInsert("\u0000")).toBe("");
  });
});

describe("stepCursor", () => {
  it("steps over a surrogate pair as one character", () => {
    const value = "a😀b";
    expect(stepCursor(value, 1, 1)).toBe(3);
    expect(stepCursor(value, 3, -1)).toBe(1);
  });

  it("clamps at both ends", () => {
    expect(stepCursor("abc", 0, -1)).toBe(0);
    expect(stepCursor("abc", 3, 1)).toBe(3);
  });
});

describe("displayWidth", () => {
  it("counts wide characters as two columns", () => {
    expect(displayWidth("abc")).toBe(3);
    expect(displayWidth("中文")).toBe(4);
    expect(displayWidth("中a")).toBe(3);
  });
});

describe("offsetAtCell", () => {
  it("maps a click to the character under it", () => {
    // A click in the box arrives as a cell: row 0, column 3 of `abcdefghij`.
    expect(offsetAtCell("abcdefghij", 10, 20, 4, 0, 3)).toBe(3);
    expect(offsetAtCell("abcdefghij", 10, 20, 4, 0, 0)).toBe(0);
    // Past the end of the text, the caret goes to the end of that row.
    expect(offsetAtCell("abcdefghij", 10, 20, 4, 0, 99)).toBe(10);
  });

  it("counts display columns, not code units", () => {
    // 中 and 文 are two columns wide each. A click anywhere on a wide
    // character puts the caret before it, exactly as the arrows do.
    expect(offsetAtCell("中文abc", 7, 20, 4, 0, 1)).toBe(0);
    expect(offsetAtCell("中文abc", 7, 20, 4, 0, 2)).toBe(1);
    expect(offsetAtCell("中文abc", 7, 20, 4, 0, 3)).toBe(1);
    expect(offsetAtCell("中文abc", 7, 20, 4, 0, 4)).toBe(2);
    // An emoji cell resolves to the end of its surrogate pair.
    expect(offsetAtCell("a😀b", 4, 20, 4, 0, 3)).toBe(3);
  });

  it("picks rows out of a window scrolled by the caret", () => {
    const value = "one\ntwo\nthree\nfour";
    // Four rows in a two-row window: the caret on the last row keeps the last
    // two rows on screen, so row 0 of the box is `three`.
    expect(offsetAtCell(value, value.length, 20, 2, 0, 0)).toBe(8);
    expect(offsetAtCell(value, value.length, 20, 2, 1, 0)).toBe(14);
    // Beyond the window clamps to the last visible row.
    expect(offsetAtCell(value, value.length, 20, 2, 9, 0)).toBe(14);
    expect(offsetAtCell(value, value.length, 20, 2, -3, 0)).toBe(8);
  });

  it("handles wrapped rows and an empty value", () => {
    // A 4-column box wraps `abcdefgh` into two rows.
    expect(offsetAtCell("abcdefgh", 8, 4, 4, 1, 0)).toBe(4);
    expect(offsetAtCell("abcdefgh", 8, 4, 4, 1, 2)).toBe(6);
    expect(offsetAtCell("", 0, 20, 4, 0, 5)).toBe(0);
  });
});
