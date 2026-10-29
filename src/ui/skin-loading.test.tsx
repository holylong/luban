import React from "react";
import { PassThrough } from "node:stream";
import { render, renderToString } from "ink";
import { afterEach, expect, it, vi } from "vitest";
import { applyTheme, findTheme, type LoadingAnimation } from "./theme.js";
import { loadPetFrames, petDotRows, PET_ROWS, rasterizePet, SkinLoading, type PetFrame } from "./skin-loading.js";

const originalAnimation = process.env.LUBAN_ANIMATION;
const originalReader = process.env.INK_SCREEN_READER;
afterEach(() => {
  applyTheme("midnight");
  if (originalAnimation === undefined) delete process.env.LUBAN_ANIMATION;
  else process.env.LUBAN_ANIMATION = originalAnimation;
  if (originalReader === undefined) delete process.env.INK_SCREEN_READER;
  else process.env.INK_SCREEN_READER = originalReader;
  vi.restoreAllMocks();
});

it("loads four distinct transparent poses from the distributed Ollo atlas", () => {
  const frames = loadPetFrames(findTheme("ollobot")!.loadingAnimation!);
  expect(frames).not.toBeNull();
  expect(frames).toHaveLength(4);
  expect(new Set(frames!.map(frame => JSON.stringify(frame))).size).toBe(4);
  for (const frame of frames!) {
    expect(frame).toHaveLength(8);
    expect(frame.every(row => row.length === 8)).toBe(true);
    const pixels = frame.flat();
    expect(pixels.some(pixel => pixel[3] === 0)).toBe(true);
    expect(pixels.some(pixel => pixel[3] > .5)).toBe(true);
  }
});

it("maps all eight dot positions and keeps the pet within four columns and two rows", () => {
  const frame: PetFrame = Array.from({ length: 8 }, () =>
    Array.from({ length: 8 }, () => [255, 255, 255, 0] as const));
  const positions = [[0, 0], [0, 1], [0, 2], [1, 0], [1, 1], [1, 2], [0, 3], [1, 3]];
  positions.forEach(([x, y], bit) => {
    frame[y!]![x!] = [255, 255, 255, 1];
    expect(petDotRows(frame)[0]!.charCodeAt(0)).toBe(0x2800 + (1 << (bit + 1)) - 1);
  });
  expect(petDotRows(frame)).toEqual(["⣿   ", "    "]);
  applyTheme("ollobot");
  process.env.LUBAN_ANIMATION = "0";
  const output = renderToString(<SkinLoading />, { columns: 80 });
  expect(output).not.toContain("▀");
  expect(output.split("\n")).toHaveLength(2);
});

it("does not mix hidden RGB from transparent pixels into the pet", () => {
  const animation: LoadingAnimation = { asset: "test", intervalMs: 180, frames: [[0, 0, 1280, 1280]] };
  const frames = rasterizePet({ width: 2, height: 1, data: new Uint8Array([255, 0, 0, 255, 0, 255, 0, 0]) }, animation);
  const visible = frames[0]!.flat().filter(pixel => pixel[3] > 0);
  expect(visible.length).toBeGreaterThan(0);
  expect(visible.every(pixel => pixel[0] === 255 && pixel[1] === 0)).toBe(true);
});

it("leaves classic skins empty and handles a missing atlas without throwing", () => {
  applyTheme("midnight");
  expect(renderToString(<SkinLoading />)).toBe("");
  expect(loadPetFrames({ asset: "skins/missing.png", frames: [[0, 0, 1280, 1280]], intervalMs: 180 })).toBeNull();
});

it("plays in a fixed height and clears its timer on unmount", async () => {
  delete process.env.LUBAN_ANIMATION;
  delete process.env.INK_SCREEN_READER;
  applyTheme("ollobot");
  const clear = vi.spyOn(globalThis, "clearInterval");
  const stdout = Object.assign(new PassThrough(), { columns: 80, rows: 32, isTTY: true });
  const stdin = Object.assign(new PassThrough(), { isTTY: true, setRawMode() {}, ref() {}, unref() {} });
  const output = new Set<string>();
  stdout.on("data", chunk => { if (String(chunk).includes("Ollobot")) output.add(String(chunk)); });
  const app = render(<SkinLoading />, { stdout: stdout as unknown as NodeJS.WriteStream, stdin: stdin as unknown as NodeJS.ReadStream, debug: true, patchConsole: false });
  try {
    await expect.poll(() => output.size).toBeGreaterThan(1);
    for (const frame of output) expect(frame.trimEnd().split("\n").length).toBeLessThanOrEqual(PET_ROWS);
  } finally {
    app.unmount();
    app.cleanup();
  }
  expect(clear).toHaveBeenCalled();
});

it("supports static and screen reader modes", () => {
  applyTheme("ollobot");
  process.env.LUBAN_ANIMATION = "0";
  expect(renderToString(<SkinLoading />, { columns: 80 })).toContain("Ollobot");
  process.env.INK_SCREEN_READER = "true";
  expect(renderToString(<SkinLoading />, { columns: 80 })).toBe("Ollobot");
});
