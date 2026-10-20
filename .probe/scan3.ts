import { readFileSync } from "node:fs";
import { PNG } from "pngjs";

const png = PNG.sync.read(readFileSync(".probe/shot.png"));
const { width, height, data } = png;

const hex = (i: number): string => `#${[data[i], data[i + 1], data[i + 2]].map((v) => v!.toString(16).padStart(2, "0")).join("")}`;

// 1) Where exactly does the purple band start and end?
console.log("=== 紫色带垂直范围 ===");
let bandStart = -1;
let bandEnd = -1;
for (let y = 0; y < height; y += 1) {
  const i = (y * width + 5) * 4;
  const [r, g, b] = [data[i]!, data[i + 1]!, data[i + 2]!];
  const purple = r > 40 && b > 20 && g < 25;
  if (purple && bandStart < 0) bandStart = y;
  if (purple) bandEnd = y;
}
console.log(`  紫色带: y=${bandStart}..${bandEnd}  高度=${bandEnd - bandStart + 1}px`);

// 2) Horizontal extent of that band: full width or only part?
console.log("\n=== 紫色带横向范围 (y=1272) ===");
const y = 1272;
let first = -1;
let last = -1;
const colours = new Map<string, number>();
for (let x = 0; x < width; x += 1) {
  const i = (y * width + x) * 4;
  const c = hex(i);
  colours.set(c, (colours.get(c) ?? 0) + 1);
  const [r, g, b] = [data[i]!, data[i + 1]!, data[i + 2]!];
  if (r > 40 && b > 20 && g < 25) {
    if (first < 0) first = x;
    last = x;
  }
}
console.log(`  x=${first}..${last}  宽度=${last - first + 1}px  (图像宽 ${width}px)`);
const top = [...colours.entries()].sort((a, b) => b[1] - a[1]).slice(0, 5);
console.log(`  主要颜色: ${top.map(([c, n]) => `${c}×${n}`).join("  ")}`);

// 3) Same probe higher up, to see what the panel background normally is.
console.log("\n=== 对比：输入框区域背景 (y=1250 / 1268 / 1281) ===");
for (const probe of [1250, 1268, 1281]) {
  const i = (probe * width + 5) * 4;
  console.log(`  y=${probe}: ${hex(i)}`);
}

// 4) The theme: element/panel colours. #300a24 is a purple panel; find which
//    theme defines it, to know which surface it belongs to.
console.log("\n=== 查找 #300a24 在源码中的定义 ===");