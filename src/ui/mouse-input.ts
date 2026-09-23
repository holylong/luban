/**
 * Mouse reports, in every encoding a terminal may use.
 *
 * Enabling mouse tracking (`?1000/?1002/?1006`) makes the terminal interleave
 * reports with keystrokes on stdin. Ink's keypress parser knows nothing about
 * them, so an unrecognised report falls through its function-key table and the
 * payload is handed to `useInput` as if it had been typed — which is how a
 * click in the composer used to paste `[<0;20;20M` (or `[32;20;20M`, or `[M`
 * plus the raw coordinate bytes) into the prompt.
 *
 * Only SGR (`?1006`) reports were filtered before, and only when the whole
 * report arrived intact inside one keypress payload. Terminals that ignore
 * `?1006` keep sending the older X10/rxvt forms, and those reached the composer
 * untouched. This module parses all three encodings from the raw bytes and
 * carries a stateful guard the composers run every insert through, so a report
 * can never become text no matter how the bytes are split.
 */

/** Button codes, normalised to the X10 numbering every encoding shares. */
export const MOUSE_WHEEL_UP = 64;
export const MOUSE_WHEEL_DOWN = 65;
export const MOUSE_RELEASE = 3;

export interface MouseReport {
  /** Button code with wheel/motion/release bits intact (X10 numbering). */
  code: number;
  /** One-based screen column, exactly as the terminal sent it. */
  x: number;
  /** One-based screen row. */
  y: number;
  /** True for a button release, however the encoding spells it. */
  released: boolean;
  /** Which encoding carried the report. */
  encoding: "sgr" | "urxvt" | "x10";
}

/** Bit 6 is set for wheel reports; the low two bits give the direction. */
export function isWheel(report: MouseReport): boolean {
  return (report.code & 64) !== 0;
}

/** Bit 5 is set while a button is held down (drag motion). */
export function isMotion(report: MouseReport): boolean {
  return (report.code & 32) !== 0;
}

/** True for a plain left press, the gesture that moves the caret. */
export function isLeftPress(report: MouseReport): boolean {
  return !report.released && !isWheel(report) && !isMotion(report) && (report.code & 3) === 0;
}

/** Decode one X10/UTF-8 coordinate: values >= 96 arrive as two bytes. */
function readExtendedNumber(bytes: Buffer, index: number): { value: number; length: number } | null {
  const first = bytes[index];
  if (first === undefined) return null;
  if (first < 0x80) return { value: first, length: 1 };
  const second = bytes[index + 1];
  if ((first & 0xc0) === 0xc0 && second !== undefined && (second & 0xc0) === 0x80) {
    return { value: ((first & 0x1f) << 6) | (second & 0x3f), length: 2 };
  }
  // A raw byte >= 0x80 in the original X10 form; keep it as one coordinate.
  return { value: first, length: 1 };
}

/**
 * Every mouse report inside one stdin chunk.
 *
 * Bytes are read directly rather than from a decoded string: the X10 form
 * carries coordinates as single bytes that are not valid UTF-8, and the
 * replacement characters a decode would produce cannot be turned back into a
 * position.
 */
export function parseMouseReports(chunk: Buffer | string): MouseReport[] {
  const bytes = typeof chunk === "string" ? Buffer.from(chunk, "latin1") : chunk;
  const reports: MouseReport[] = [];
  let index = 0;
  while (index < bytes.length) {
    if (bytes[index] !== 0x1b || bytes[index + 1] !== 0x5b /* [ */) {
      index += 1;
      continue;
    }
    const payload = index + 2;
    const head = bytes[payload];
    if (head === undefined) break;

    if (head === 0x3c /* < */) { // SGR: ESC [ < button ; column ; row M|m
      let cursor = payload + 1;
      let body = "";
      while (cursor < bytes.length && bytes[cursor] !== 0x4d && bytes[cursor] !== 0x6d) {
        body += String.fromCharCode(bytes[cursor]!);
        cursor += 1;
      }
      const terminator = bytes[cursor];
      const fields = body.split(";");
      if (terminator === undefined) break;
      if (fields.length === 3) {
        const [code, x, y] = fields.map(Number) as [number, number, number];
        if (Number.isFinite(code) && Number.isFinite(x) && Number.isFinite(y)) {
          reports.push({ code, x, y, released: terminator === 0x6d || code === MOUSE_RELEASE, encoding: "sgr" });
        }
      }
      index = cursor + 1;
      continue;
    }

    if (head === 0x4d /* M */) { // X10 / UTF-8: ESC [ M b x y
      let cursor = payload + 1;
      const values: number[] = [];
      while (values.length < 3) {
        const number = readExtendedNumber(bytes, cursor);
        if (!number) break;
        values.push(number.value);
        cursor += number.length;
      }
      if (values.length < 3) break;
      const [code, x, y] = values.map((value) => value - 32) as [number, number, number];
      reports.push({ code, x, y, released: code === MOUSE_RELEASE, encoding: "x10" });
      index = cursor;
      continue;
    }

    // rxvt 1015: ESC [ button ; column ; row M — the byte after `[` is a digit,
    // which is what tells it apart from every real CSI function-key sequence.
    if (head >= 0x30 && head <= 0x39) {
      let cursor = payload;
      let body = "";
      while (cursor < bytes.length && bytes[cursor] !== 0x4d && bytes[cursor] !== 0x6d) {
        const byte = bytes[cursor]!;
        if (byte < 0x30 || byte > 0x39) {
          if (byte !== 0x3b) break;
        }
        body += String.fromCharCode(byte);
        cursor += 1;
      }
      const terminator = bytes[cursor];
      const fields = body.split(";");
      if (terminator === undefined) break;
      if (fields.length === 3 && fields.every((field) => field.length > 0)) {
        const [code, x, y] = fields.map(Number) as [number, number, number];
        if (Number.isFinite(code) && Number.isFinite(x) && Number.isFinite(y)) {
          const button = code - 32;
          reports.push({ code: button, x, y, released: terminator === 0x6d || button === MOUSE_RELEASE, encoding: "urxvt" });
        }
      }
      index = cursor + 1;
      continue;
    }

    index += 1;
  }
  return reports;
}

/** A complete mouse report, with or without the escape byte Ink strips. */
const COMPLETE_REPORT = /\u001b?\[<\d+;\d{1,4};\d{1,4}[Mm]|\u001b?\[(?:3[2-9]|[4-9]\d|\d{3,});\d{1,4};\d{1,4}[Mm]/gu;
/** The start of a report that has not arrived in full yet. */
const PARTIAL_REPORT = /\u001b?\[<\d*(?:;\d*){0,2}$|\u001b?\[(?:3[2-9]|[4-9]\d|\d{3,})(?:;\d*){0,2}$/u;
/** X10 reports carry three raw coordinate bytes after the `[M` prefix. */
const X10_COORDINATE_BYTES = 3;
/** Longest prefix worth holding back while a report is still incomplete. */
const MAX_HELD = 24;

/** Drop every mouse report from a value that already reached the model. */
export function stripMouseReports(value: string): string {
  return value.replaceAll(COMPLETE_REPORT, "");
}

/**
 * Stateful filter for keyboard payloads.
 *
 * Two things a plain regex on the value cannot do:
 *
 *  - a report split across keypress payloads (X10 is parsed as `[M` first and
 *    the three coordinate bytes arrive as the *next* payload), so the bytes
 *    have to be swallowed by count;
 *  - a report that stalls mid-sequence and is flushed by Ink as a bare prefix,
 *    which must be held instead of inserted.
 *
 * The X10 swallow only arms once the terminal has actually been seen sending
 * X10 reports, so typing a literal `[M` on a terminal that reports in SGR is
 * never eaten.
 */
export interface MouseInputGuard {
  /** Remember the encoding the terminal actually reports in. */
  observe(report: MouseReport): void;
  /** Forget the encoding, e.g. when mouse reporting is switched off. */
  reset(): void;
  /** Remove mouse bytes from one keypress payload. */
  filter(input: string): string;
}

export function createMouseInputGuard(): MouseInputGuard {
  let encoding: MouseReport["encoding"] | null = null;
  let held = "";
  let swallow = 0;
  return {
    observe(report) {
      encoding = report.encoding;
    },
    reset() {
      encoding = null;
      held = "";
      swallow = 0;
    },
    filter(input) {
      let text = held + input;
      held = "";
      let out = "";
      // Coordinate bytes that belong to an X10 report already seen.
      if (swallow > 0) {
        for (const char of text) {
          if (swallow === 0) out += char;
          else swallow -= 1;
        }
        text = "";
        if (swallow > 0) return out;
      }
      // The X10 prefix arrives on its own; its three coordinate bytes are the
      // next payload and are not valid UTF-8, so they cannot be pattern-matched.
      if (encoding === "x10" && text.endsWith("[M")) {
        swallow = X10_COORDINATE_BYTES;
        text = text.slice(0, -2);
      }
      text = stripMouseReports(text);
      const partial = PARTIAL_REPORT.exec(text);
      if (partial && partial[0].length > 1) {
        held = partial[0].slice(0, MAX_HELD);
        text = text.slice(0, partial.index);
      }
      return out + text;
    },
  };
}

/** The slice of Ink's DOM node needed to map a click onto the screen. */
export interface ScreenNode {
  yogaNode?: { getComputedLayout(): { top: number; left: number; width?: number; height?: number } };
  parentNode?: ScreenNode;
}

export interface ScreenRect {
  /** Zero-based cells from the top of the terminal. */
  top: number;
  left: number;
  width: number;
  height: number;
}

/**
 * Absolute screen rectangle of a rendered node. Yoga reports each box relative
 * to its parent, so the ancestor chain has to be summed.
 */
export function screenRect(node: ScreenNode | null | undefined): ScreenRect | null {
  if (!node?.yogaNode) return null;
  const own = node.yogaNode.getComputedLayout?.();
  let top = 0;
  let left = 0;
  let current: ScreenNode | undefined = node;
  while (current) {
    const layout = current.yogaNode?.getComputedLayout?.();
    if (layout) {
      top += Number.isFinite(layout.top) ? layout.top : 0;
      left += Number.isFinite(layout.left) ? layout.left : 0;
    }
    current = current.parentNode;
  }
  return {
    top,
    left,
    width: Number.isFinite(own?.width) ? own!.width! : 0,
    height: Number.isFinite(own?.height) ? own!.height! : 0,
  };
}

/**
 * Translate a report into a cell inside a node, or null when it landed
 * elsewhere. The terminal counts rows and columns from one; yoga from zero.
 */
export function cellIn(rect: ScreenRect | null, report: MouseReport): { row: number; column: number } | null {
  if (!rect || rect.height <= 0) return null;
  const row = report.y - 1 - rect.top;
  const column = report.x - 1 - rect.left;
  if (row < 0 || row >= rect.height) return null;
  if (column < 0 || column >= rect.width) return null;
  return { row, column };
}
