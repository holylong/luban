import { readFileSync } from "node:fs";
import { PNG } from "pngjs";

const png = PNG.sync.read(readFileSync(".probe/shot.png"));
const at = (x: number, y: number): [number, number, number] => {
  const i = (y * png.width + x) * 4;
  return [png.data[i]!, png.data[i + 1]!, png.data[i + 2]!];
};
const hex = ([r, g, b]: [number, number, number]): string => `#${[r, g, b].map((v) => v.toString(16).padStart(2, "0")).join("")}`;

// The two dominant purples: #33111a covers 446210px, #300a24 covers 17799px.
// If they were different luban surfaces, the composer panel would show the
// theme's declared `element` colour. Measure how many scanlines each spans.
function span(colour: [number, number, number]): { rows: number; first: number; last: number; x0: number; x1: number } {
  let rows = 0;
  let first = -1;
  let last = -1;
  let x0 = -1;
  let x1 = -1;
  for (let y = 0; y < png.height; y += 1) {
    let hit = false;
    for (let x = 0; x < png.width; x += 8) {
      const c = at(x, y);
      if (Math.abs(c[0] - colour[0]) < 3 && Math.abs(c[1] - colour[1]) < 3 && Math.abs(c[2] - colour[2]) < 3) {
        hit = true;
        if (x0 < 0) x0 = x;
        x1 = x;
        break;
      }
    }
    if (hit) { rows += 1; if (first < 0) first = y; last = y; }
  }
  return { rows, first, last, x0, x1 };
}

const a = span([0x33, 0x11, 0x1a]);
const b = span([0x30, 0x0a, 0x24]);
console.log(`#33111a: ${a.rows} 扫描行  y=${a.first}..${a.last}  x=${a.x0}..${a.x1}`);
console.log(`#300a24: ${b.rows} 扫描行  y=${b.first}..${b.last}  x=${b.x0}..${b.x1}`);

// Difference between the two purples: is one a uniform shift of the other?
console.log(`\n差值: #33111a - #300a24 = [${0x33 - 0x30}, ${0x11 - 0x0a}, ${0x1a - 0x24}]`);

// Sample the exact vertical profile of the bottom 120 rows at x=5.
console.log("\n=== 底部 120 行垂直颜色剖面 (x=5) ===");
let previous = "";
for (let y = png.height - 120; y < png.height; y += 1) {
  const c = hex(at(5, y));
  if (c !== previous) {
    console.log(`  y=${String(y).padStart(4)}  ${c}`);
    previous = c;
  }
}