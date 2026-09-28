import { expect, it } from "vitest";
import { sessionColor } from "./session-color.js";
import { THEMES } from "./theme.js";

function luminance(hex: string): number {
  const channels = [1, 3, 5].map((at) => parseInt(hex.slice(at, at + 2), 16) / 255);
  const linear = channels.map((value) => value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4);
  return 0.2126 * linear[0]! + 0.7152 * linear[1]! + 0.0722 * linear[2]!;
}

function contrast(first: string, second: string): number {
  const [lighter, darker] = [luminance(first), luminance(second)].sort((a, b) => b - a);
  return (lighter! + 0.05) / (darker! + 0.05);
}

it("gives session records distinct readable colors in every theme", () => {
  for (const { id, mode, palette } of THEMES) {
    const colors = Array.from({ length: 60 }, (_, index) => sessionColor(index, mode));
    expect(new Set(colors).size, `${id} distinct colors`).toBe(colors.length);
    for (const color of colors) {
      expect(contrast(color, palette.panel), `${id} panel ${color}`).toBeGreaterThanOrEqual(4.5);
      expect(contrast(color, palette.selected), `${id} selected ${color}`).toBeGreaterThanOrEqual(4.5);
    }
  }
});
