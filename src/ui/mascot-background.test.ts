import { PassThrough } from "node:stream";
import { stripVTControlCharacters } from "node:util";
import { expect, it } from "vitest";
import { createMascotFrameWriter, mascotOutput } from "./mascot-background.js";
import { createTerminalFrameWriter } from "./terminal-output.js";

const image = { width: 2, height: 2, data: Uint8Array.from([
  255, 255, 255, 255, 255, 255, 255, 0,
  255, 255, 255, 255, 255, 255, 255, 255,
]) };
const canvas = "\u001b[48;2;11;15;20m";
const frame = (cols = 80, rows = 24) => Array.from({ length: rows - 1 }, () => canvas + " ".repeat(cols) + "\u001b[49m\n").join("");
const erase = (rows: number) => "\u001b[2K\u001b[1A".repeat(rows - 1) + "\u001b[2K\u001b[G";

it("paints only empty canvas cells with faint color and leaves text/styles intact", () => {
  const write = createMascotFrameWriter(image);
  const glyphs = "\u001b[38;2;200;210;220m中文 👩‍💻 ✓\u001b[39m";
  const input = frame().split("\n").map((line, row) => row === 8 ? line.replace(" ".repeat(12), glyphs + "  ") : line).join("\n");
  const output = write(input, 80, 24);
  expect(stripVTControlCharacters(output)).toBe(stripVTControlCharacters(input));
  expect(output).toContain(glyphs);
  expect(output).toContain("\u001b[48;2;35;39;44m");
  expect(output.replace(/\u001b\[[\d;]*m/g, "")).toBe(input.replace(/\u001b\[[\d;]*m/g, ""));
  // Neither header nor composer gets any image color.
  expect(output.split("\n").slice(0, 3)).toEqual(input.split("\n").slice(0, 3));
  expect(output.split("\n").slice(-6)).toEqual(input.split("\n").slice(-6));
});

it("preserves opaque selections and panel backgrounds, including combined SGR", () => {
  const write = createMascotFrameWriter(image);
  const input = frame().replaceAll(canvas, "\u001b[1;38;2;210;220;230;48;2;37;54;75m");
  expect(write(input, 80, 24)).toBe(input);
  expect(write(frame().replaceAll(canvas, "\u001b[48;5;16m"), 80, 24)).not.toBe(frame().replaceAll(canvas, "\u001b[48;5;16m"));
});

it("ignores logs, unknown controls, partial frames, tiny terminals and transparent images", () => {
  const write = createMascotFrameWriter(image);
  for (const input of ["log\n", "\u001b[?25l", "\u001b]52;c;abc\u0007", "\u001b[2J" + frame(), frame(80, 23)]) {
    expect(write(input, 80, 24)).toBe(input);
  }
  expect(write(frame(30), 30, 24)).toBe(frame(30));
  expect(createMascotFrameWriter({ ...image, data: new Uint8Array(16) })(frame(), 80, 24)).toBe(frame());
});

it("recomputes the raster for light themes and terminal resizing and supports 256 colors", () => {
  const write = createMascotFrameWriter(image);
  const light = frame().replaceAll(canvas, "\u001b[48;2;255;255;255m");
  expect(stripVTControlCharacters(write(light, 80, 24, "#ffffff"))).toBe(stripVTControlCharacters(light));
  const resized = frame(120, 30);
  expect(write(resized, 120, 30)).not.toBe(resized);
  const indexed = frame().replaceAll(canvas, "\u001b[48;5;16m");
  const output = createMascotFrameWriter(image, false)(indexed, 80, 24);
  expect(output).not.toBe(indexed);
  expect(output).not.toContain("48;2;");
});

it("keeps terminal row updates stable after applying the background", () => {
  const decorate = createMascotFrameWriter(image);
  const windows = createTerminalFrameWriter();
  windows(decorate(frame(), 80, 24));
  const output = windows(decorate(erase(24) + frame(), 80, 24));
  expect(output).toBe("\u001b[23A\u001b[G" + "\u001b[E".repeat(23));
});

it("skips redirected, disabled, screen-reader and colorless streams", () => {
  const stream = Object.assign(new PassThrough(), { isTTY: true }) as unknown as NodeJS.WriteStream;
  for (const env of [{ LUBAN_MASCOT: "0" }, { INK_SCREEN_READER: "true" }, { NO_COLOR: "" }, { TERM: "dumb" }, { FORCE_COLOR: "0" }]) {
    expect(mascotOutput(stream, env)).toBe(stream);
  }
  stream.isTTY = false;
  expect(mascotOutput(stream, {})).toBe(stream);
});
