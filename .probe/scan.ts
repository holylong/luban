import { readFileSync } from "node:fs";
import { PNG } from "pngjs";

const png = PNG.sync.read(readFileSync(".probe/shot.png"));
console.log(`尺寸: ${png.width}x${png.height}`);

// A terminal screenshot is mostly one background colour with text pixels on top.
// For each scanline, count pixels that differ from the row's dominant colour;
// that count is the "ink" on that line, i.e. how much text it carries.
const { width, height, data } = png;
const ink: number[] = [];
for (let y = 0; y < height; y += 1) {
  // Sample the row's most common colour as its background.
  const seen = new Map<number, number>();
  for (let x = 0; x < width; x += 4) {
    const i = (y * width + x) * 4;
    const key = (data[i]! << 16) | (data[i + 1]! << 8) | data[i + 2]!;
    seen.set(key, (seen.get(key) ?? 0) + 1);
  }
  let background = 0;
  let best = -1;
  for (const [key, count] of seen) {
    if (count > best) { best = count; background = key; }
  }
  let different = 0;
  for (let x = 0; x < width; x += 1) {
    const i = (y * width + x) * 4;
    const key = (data[i]! << 16) | (data[i + 1]! << 8) | data[i + 2]!;
    if (key !== background) different += 1;
  }
  ink.push(different);
}

// A text row is any scanline carrying ink; a blank row carries almost none.
const threshold = Math.max(6, Math.round(width * 0.01));
const isTextRow = ink.map((value) => value > threshold);
let runs: Array<[number, number]> = [];
let start = -1;
for (let y = 0; y <= height; y += 1) {
  const on = y < height && isTextRow[y];
  if (on && start < 0) start = y;
  if (!on && start >= 0) { runs.push([start, y - 1]); start = -1; }
}
console.log(`文本行段数: ${runs.length}`);
console.log("\n=== 底部区域逐行墨量（最后 40 行）===");
for (let y = Math.max(0, height - 40); y < height; y += 1) {
  const bar = "#".repeat(Math.min(60, Math.round(ink[y]! / Math.max(1, threshold))));
  console.log(`${String(y).padStart(4)} ${String(ink[y]).padStart(6)} ${isTextRow[y] ? "T" : " "} ${bar}`);
}