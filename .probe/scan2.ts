import { readFileSync } from "node:fs";
import { PNG } from "pngjs";

const png = PNG.sync.read(readFileSync(".probe/shot.png"));
const { width, height, data } = png;

function rowInk(y: number): { different: number; background: number } {
  const seen = new Map<number, number>();
  for (let x = 0; x < width; x += 4) {
    const i = (y * width + x) * 4;
    const key = (data[i]! << 16) | (data[i + 1]! << 8) | data[i + 2]!;
    seen.set(key, (seen.get(key) ?? 0) + 1);
  }
  let background = 0;
  let best = -1;
  for (const [key, count] of seen) if (count > best) { best = count; background = key; }
  let different = 0;
  for (let x = 0; x < width; x += 1) {
    const i = (y * width + x) * 4;
    const key = (data[i]! << 16) | (data[i + 1]! << 8) | data[i + 2]!;
    if (key !== background) different += 1;
  }
  return { different, background };
}

const ink = Array.from({ length: height }, (_, y) => rowInk(y).different);
const threshold = Math.max(6, Math.round(width * 0.01));

// Locate the composer: the bottom-most text block that starts near the left
// edge with the mode label, i.e. the input panel.
console.log("=== 全部文本行段 ===");
let start = -1;
const runs: Array<[number, number]> = [];
for (let y = 0; y <= height; y += 1) {
  const on = y < height && ink[y]! > threshold;
  if (on && start < 0) start = y;
  if (!on && start >= 0) { runs.push([start, y - 1]); start = -1; }
}
for (const [a, b] of runs) console.log(`  y=${a}..${b}  高度=${b - a + 1}  峰值墨量=${Math.max(...ink.slice(a, b + 1))}`);

// The composer panel has a distinct background from the app background.
// Sample the colour at the far left of each row in the bottom region.
console.log("\n=== 底部区域背景色（判断输入框面板范围）===");
for (let y = 1230; y < height; y += 2) {
  const i = (y * width + 5) * 4;
  const rgb = `#${[data[i], data[i + 1], data[i + 2]].map((v) => v!.toString(16).padStart(2, "0")).join("")}`;
  console.log(`  y=${String(y).padStart(4)}  墨量=${String(ink[y]).padStart(4)}  背景=${rgb}`);
}