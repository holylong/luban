import { describe, expect, test } from "vitest";
import {
  MOUSE_WHEEL_DOWN,
  MOUSE_WHEEL_UP,
  cellIn,
  createMouseInputGuard,
  isLeftPress,
  isMotion,
  isWheel,
  parseMouseReports,
  screenRect,
  stripMouseReports,
  type MouseReport,
} from "./mouse-input.js";

const bytes = (value: string): Buffer => Buffer.from(value, "latin1");

describe("parseMouseReports", () => {
  test("reads an SGR report", () => {
    const [report] = parseMouseReports(bytes("\u001b[<0;20;12M"));
    expect(report).toEqual<MouseReport>({ code: 0, x: 20, y: 12, released: false, encoding: "sgr" });
  });

  test("reads an SGR release and a wheel notch", () => {
    const [release] = parseMouseReports(bytes("\u001b[<0;20;12m"));
    expect(release).toMatchObject({ code: 0, released: true });
    const [wheel] = parseMouseReports(bytes("\u001b[<64;20;12M"));
    expect(wheel).toMatchObject({ code: MOUSE_WHEEL_UP, released: false });
    expect(isWheel(wheel!)).toBe(true);
    const [down] = parseMouseReports(bytes("\u001b[<65;20;12M"));
    expect(down!.code).toBe(MOUSE_WHEEL_DOWN);
  });

  test("reads an rxvt 1015 report and normalises its button offset", () => {
    const [report] = parseMouseReports(bytes("\u001b[32;20;12M"));
    expect(report).toEqual<MouseReport>({ code: 0, x: 20, y: 12, released: false, encoding: "urxvt" });
    const [wheel] = parseMouseReports(bytes("\u001b[96;20;12M"));
    expect(wheel).toMatchObject({ code: MOUSE_WHEEL_UP, encoding: "urxvt" });
    expect(isWheel(wheel!)).toBe(true);
    const [release] = parseMouseReports(bytes("\u001b[35;20;12M"));
    expect(release).toMatchObject({ code: 3, released: true, encoding: "urxvt" });
  });

  test("reads an X10 report and its raw coordinate bytes", () => {
    // Button 0, column 20, row 12, all offset by 32.
    const [report] = parseMouseReports(Buffer.from([0x1b, 0x5b, 0x4d, 32, 20 + 32, 12 + 32]));
    expect(report).toEqual<MouseReport>({ code: 0, x: 20, y: 12, released: false, encoding: "x10" });
  });

  test("reads a UTF-8 extended X10 report beyond 95 columns", () => {
    const encode = (value: number): number[] => value < 96
      ? [value + 32]
      : [0xc0 | ((value + 32) >> 6), 0x80 | ((value + 32) & 0x3f)];
    const [report] = parseMouseReports(Buffer.from([0x1b, 0x5b, 0x4d, 32, ...encode(150), ...encode(12)]));
    expect(report).toMatchObject({ x: 150, y: 12, code: 0, encoding: "x10" });
  });

  test("keeps keystrokes and other escape sequences out of the report list", () => {
    expect(parseMouseReports(bytes("hello"))).toEqual([]);
    expect(parseMouseReports(bytes("\u001b[A\u001b[3~"))).toEqual([]);
    // An incomplete report is not guessed at.
    expect(parseMouseReports(bytes("\u001b[<0;20"))).toEqual([]);
  });

  test("finds several reports in one chunk and ignores the text between them", () => {
    const reports = parseMouseReports(bytes("a\u001b[<64;5;5Mb\u001b[<65;5;5M"));
    expect(reports.map((report) => report.code)).toEqual([MOUSE_WHEEL_UP, MOUSE_WHEEL_DOWN]);
  });

  test("classifies motion and left press", () => {
    const [motion] = parseMouseReports(bytes("\u001b[<32;5;5M"));
    expect(isMotion(motion!)).toBe(true);
    expect(isLeftPress(motion!)).toBe(false);
    const [press] = parseMouseReports(bytes("\u001b[<0;5;5M"));
    expect(isLeftPress(press!)).toBe(true);
    const [release] = parseMouseReports(bytes("\u001b[<0;5;5m"));
    expect(isLeftPress(release!)).toBe(false);
  });
});

describe("stripMouseReports", () => {
  test("removes SGR and rxvt reports from a value", () => {
    expect(stripMouseReports("abc\u001b[<0;20;20M")).toBe("abc");
    expect(stripMouseReports("abc\u001b[32;20;20M")).toBe("abc");
    // Ink hands the payload over without the escape byte.
    expect(stripMouseReports("abc[<0;20;20M")).toBe("abc");
    expect(stripMouseReports("abc[32;20;20M")).toBe("abc");
    expect(stripMouseReports("[<0;20;20M[<0;20;20m")).toBe("");
  });

  test("leaves ordinary text that merely looks bracketed alone", () => {
    expect(stripMouseReports("see [1;2;3] and [x]")).toBe("see [1;2;3] and [x]");
    expect(stripMouseReports("- [ ] todo")).toBe("- [ ] todo");
  });
});

describe("createMouseInputGuard", () => {
  test("drops SGR payloads, split or whole", () => {
    const guard = createMouseInputGuard();
    guard.observe({ code: 0, x: 1, y: 1, released: false, encoding: "sgr" });
    expect(guard.filter("[<0;20;20M")).toBe("");
    expect(guard.filter("[<0;20")).toBe("");
    expect(guard.filter(";20M")).toBe("");
    expect(guard.filter("hello")).toBe("hello");
  });

  test("drops rxvt payloads", () => {
    const guard = createMouseInputGuard();
    guard.observe({ code: 0, x: 1, y: 1, released: false, encoding: "urxvt" });
    expect(guard.filter("[32;20;20M")).toBe("");
    expect(guard.filter("[35;20;20M")).toBe("");
    expect(guard.filter("ok")).toBe("ok");
  });

  test("swallows the X10 coordinate bytes that follow the prefix", () => {
    const guard = createMouseInputGuard();
    guard.observe({ code: 0, x: 1, y: 1, released: false, encoding: "x10" });
    // Ink parses `ESC [ M` as one keypress and the three raw bytes as the next.
    expect(guard.filter("[M")).toBe("");
    expect(guard.filter(" !#")).toBe("");
    expect(guard.filter("after")).toBe("after");
  });

  test("never eats a typed [M on a terminal that reports in SGR", () => {
    const guard = createMouseInputGuard();
    guard.observe({ code: 0, x: 1, y: 1, released: false, encoding: "sgr" });
    expect(guard.filter("[M")).toBe("[M");
    expect(guard.filter("arkdown")).toBe("arkdown");
  });

  test("forgets the encoding once mouse reporting is switched off", () => {
    const guard = createMouseInputGuard();
    guard.observe({ code: 0, x: 1, y: 1, released: false, encoding: "x10" });
    guard.reset();
    expect(guard.filter("[M")).toBe("[M");
  });

  test("keeps ordinary typing intact around held prefixes", () => {
    const guard = createMouseInputGuard();
    expect(guard.filter("hello ")).toBe("hello ");
    // `[1` is not the start of any mouse report, so it is inserted as typed.
    expect(guard.filter("[1")).toBe("[1");
    expect(guard.filter("2] done")).toBe("2] done");
    // A real report prefix is held until the rest arrives.
    expect(guard.filter("[<0;20;5")).toBe("");
    expect(guard.filter("M")).toBe("");
  });
});

describe("screen geometry", () => {
  const node = (top: number, left: number, width: number, height: number, parent?: unknown): never =>
    ({ yogaNode: { getComputedLayout: () => ({ top, left, width, height }) }, parentNode: parent }) as never;

  test("sums the ancestor chain but keeps the node's own size", () => {
    const outer = node(10, 2, 80, 24);
    const inner = node(3, 4, 40, 6, outer);
    expect(screenRect(inner)).toEqual({ top: 13, left: 6, width: 40, height: 6 });
    expect(screenRect(outer)).toEqual({ top: 10, left: 2, width: 80, height: 24 });
    expect(screenRect(null)).toBeNull();
  });

  test("maps a one-based report onto a zero-based cell", () => {
    const rect = { top: 13, left: 6, width: 40, height: 6 };
    const at = (x: number, y: number) => cellIn(rect, { code: 0, x, y, released: false, encoding: "sgr" });
    expect(at(8, 14)).toEqual({ row: 0, column: 1 });
    expect(at(7, 14)).toEqual({ row: 0, column: 0 });
    expect(at(46, 19)).toEqual({ row: 5, column: 39 });
    // Outside, on every edge: one cell past the last row/column, one before the first.
    expect(at(7, 13)).toBeNull();
    expect(at(6, 14)).toBeNull();
    expect(at(47, 14)).toBeNull();
    expect(at(7, 20)).toBeNull();
    expect(cellIn(null, { code: 0, x: 7, y: 14, released: false, encoding: "sgr" })).toBeNull();
  });
});
