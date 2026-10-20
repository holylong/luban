import { readFileSync } from "node:fs";
import { PNG } from "pngjs";

const png = PNG.sync.read(readFileSync(".probe/shot.png"));
const at = (x: number, y: number): [number, number, number] => {
  const i = (y * png.width + x) * 4;
  return [png.data[i]!, png.data[i + 1]!, png.data[i + 2]!];
};
const hex = ([r, g, b]: [number, number, number]): string => `#${[r, g, b].map((v) => v.toString(16).padStart(2, "0")).join("")}`;

// The screenshot's own palette, sampled where nothing is drawn.
const appBg = hex(at(5, 600));
const panel = hex(at(5, 1250));
const band = hex(at(5, 1270));
console.log(`实测: 应用背景=${appBg}  输入面板=${panel}  底部横带=${band}`);

// Theme "樱花粉" declares background #1b1016, panel #241722, element #33202f.
// Every one of those is a *darker* neighbour than what the screenshot shows, so
// the terminal is rendering the panel with some opacity or gamma over black.
const declared: Array<[string, [number, number, number]]> = [
  ["background #1b1016", [0x1b, 0x10, 0x16]],
  ["panel #241722", [0x24, 0x17, 0x22]],
  ["element #33202f", [0x33, 0x20, 0x2f]],
];
console.log("\n主题声明值 vs 截图实测:");
for (const [name, rgb] of declared) console.log(`  ${name.padEnd(18)} = ${hex(rgb)}`);

// Does the band match any declared colour exactly?
console.log("\n底部横带是否等于某个主题色:");
const bandRgb = at(5, 1270);
for (const [name, rgb] of declared) {
  console.log(`  ${name.padEnd(18)} ${rgb.join(",") === bandRgb.join(",") ? "完全相同" : "不同"}`);
}

// How many distinct colours does the whole image use? A terminal screenshot
// that has repainted over itself often shows gradients a clean frame cannot.
const counts = new Map<string, number>();
for (let y = 0; y < png.height; y += 1) {
  for (let x = 0; x < png.width; x += 1) counts.set(hex(at(x, y)), (counts.get(hex(at(x, y))) ?? 0) + 1);
}
const top = [...counts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 8);
console.log(`\n全图主色 (共 ${counts.size} 种):`);
for (const [c, n] of top) console.log(`  ${c} × ${n}`);