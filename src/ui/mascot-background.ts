import { existsSync, readFileSync } from "node:fs";
import { PNG } from "pngjs";
import stringWidth from "string-width";
import { activeThemeId, theme } from "./theme.js";

type RGB = [number, number, number];
export interface MascotImage { width: number; height: number; data: Uint8Array }

const sgr = /\u001b\[[\d;]*m/g;
const erasePrefix = /^(?:\u001b\[2K\u001b\[1A)*\u001b\[2K\u001b\[G/;
const rgb = (hex: string): RGB | undefined => /^#[\da-f]{6}$/i.test(hex)
  ? [parseInt(hex.slice(1, 3), 16), parseInt(hex.slice(3, 5), 16), parseInt(hex.slice(5, 7), 16)] : undefined;

function ansi256([r, g, b]: RGB): number {
  if (r === g && g === b) return r < 8 ? 16 : r > 248 ? 231 : Math.round((r - 8) / 247 * 24) + 232;
  return 16 + 36 * Math.round(r / 255 * 5) + 6 * Math.round(g / 255 * 5) + Math.round(b / 255 * 5);
}

/** Add image color only to blank canvas cells. All glyphs and their styles stay
 * untouched, including wide CJK/emoji, selected rows and opaque panel surfaces.
 * No graphics protocol, cursor movement or extra screen row is introduced. */
export function createMascotFrameWriter(image: MascotImage, trueColor = true) {
  let cacheKey = "";
  let raster: Array<Array<string | undefined>> = [];
  let baseTrue = "";
  let base256 = "";
  let left = image.width, top = image.height, right = -1, bottom = -1;
  for (let y = 0; y < image.height; y++) for (let x = 0; x < image.width; x++) {
    if (image.data[(y * image.width + x) * 4 + 3]! < 32) continue;
    left = Math.min(left, x); right = Math.max(right, x);
    top = Math.min(top, y); bottom = Math.max(bottom, y);
  }

  return (chunk: string, columns: number, rows: number, background = theme.background): string => {
    const base = rgb(background);
    const prefix = erasePrefix.exec(chunk)?.[0] ?? "";
    const frame = chunk.slice(prefix.length);
    const plain = frame.replace(sgr, "");
    // Ignore logs, partial writes, cursor/mouse/clipboard controls and frames
    // during an in-progress resize. Ink's normal full frame is rows - 1 tall.
    if (!base || right < left || columns < 40 || rows < 12 || !frame.endsWith("\n")
      || /[\u001b\r\b]/.test(plain) || plain.split("\n").length !== rows) return chunk;

    const key = `${columns}:${rows}:${background}`;
    if (key !== cacheKey) {
      cacheKey = key;
      baseTrue = `48;2;${base.join(";")}`;
      base256 = `48;5;${ansi256(base)}`;
      raster = [];
      // Leave the header, composer and right-hand task plan outside the art.
      const availableWidth = columns - (columns < 110 ? 26 : 35) - 6;
      const availableHeight = rows - 9;
      const aspect = (right - left + 1) / (bottom - top + 1);
      const height = Math.max(1, Math.min(availableHeight, Math.floor(availableWidth / (aspect * 2))));
      const width = Math.max(1, Math.floor(height * aspect * 2));
      const startX = 3 + Math.floor((availableWidth - width) / 2);
      const startY = 3 + Math.floor((availableHeight - height) / 2);
      for (let y = 0; y < height; y++) {
        const line: Array<string | undefined> = raster[startY + y] = [];
        for (let x = 0; x < width; x++) {
          // Average 16 samples with premultiplied alpha. Transparent margins
          // neither paint a rectangle nor contribute their hidden RGB values.
          let alpha = 0;
          const color: RGB = [0, 0, 0];
          for (let sy = 0; sy < 4; sy++) for (let sx = 0; sx < 4; sx++) {
            const px = left + Math.min(right - left, Math.floor((x + (sx + .5) / 4) / width * (right - left + 1)));
            const py = top + Math.min(bottom - top, Math.floor((y + (sy + .5) / 4) / height * (bottom - top + 1)));
            const index = (py * image.width + px) * 4;
            const a = image.data[index + 3]! / 255;
            alpha += a;
            for (let c = 0; c < 3; c++) color[c]! += image.data[index + c]! * a;
          }
          if (alpha < .1) continue;
          const opacity = alpha / 16 * .10;
          const blended = base.map((value, c) => Math.round(value * (1 - opacity) + color[c]! / alpha * opacity)) as RGB;
          line[startX + x] = trueColor ? `48;2;${blended.join(";")}` : `48;5;${ansi256(blended)}`;
        }
      }
    }

    let row = 0, column = 0, backgroundCode = "";
    let output = prefix;
    // Preserve the original SGR tokens byte-for-byte. Only insert temporary
    // background SGR around runs of spaces, then immediately restore it.
    for (const token of frame.split(/(\u001b\[[\d;]*m|\n)/)) {
      if (token === "\n") { output += token; row++; column = 0; continue; }
      if (token.startsWith("\u001b[")) {
        const codes = token.slice(2, -1).split(";").map(Number);
        for (let i = 0; i < codes.length; i++) {
          const code = codes[i];
          if (code === 0 || code === 49) backgroundCode = "";
          if ((code! >= 40 && code! <= 47) || (code! >= 100 && code! <= 107)) backgroundCode = String(code);
          if (code === 38 || code === 48) {
            const length = codes[i + 1] === 2 ? 5 : codes[i + 1] === 5 ? 3 : 1;
            if (code === 48) backgroundCode = codes.slice(i, i + length).join(";");
            i += length - 1;
          }
        }
        output += token;
        continue;
      }
      if (backgroundCode !== baseTrue && backgroundCode !== base256) {
        output += token; column += stringWidth(token); continue;
      }
      for (const part of token.split(/( +)/)) {
        if (part.startsWith(" ")) {
          let current = backgroundCode;
          for (let x = 0; x < part.length; x++) {
            const desired = raster[row]?.[column++] ?? backgroundCode;
            if (desired !== current) { output += `\u001b[${desired}m`; current = desired; }
            output += " ";
          }
          if (current !== backgroundCode) output += `\u001b[${backgroundCode}m`;
        } else { output += part; column += stringWidth(part); }
      }
    }
    return output;
  };
}

/** A stream proxy keeps Ink's resize events, callbacks and terminal row-diff
 * adapter intact. Headless runs never pass through this wrapper. */
export function mascotOutput(stdout: NodeJS.WriteStream, env = process.env): NodeJS.WriteStream {
  if (!stdout.isTTY || env.LUBAN_MASCOT === "0" || env.INK_SCREEN_READER === "true"
    || env.NO_COLOR !== undefined || env.FORCE_COLOR === "0" || env.TERM === "dumb") return stdout;
  let image: PNG;
  try {
    const built = new URL("../assets/luban-mascot.png", import.meta.url);
    image = PNG.sync.read(readFileSync(existsSync(built) ? built : new URL("../../assets/luban-mascot.png", import.meta.url)));
  } catch { return stdout; }
  const trueColor = /^(truecolor|24bit)$/i.test(env.COLORTERM ?? "") || env.FORCE_COLOR === "3"
    || Boolean(env.WT_SESSION) || /kitty|direct/i.test(env.TERM ?? "");
  const transform = createMascotFrameWriter(image, trueColor);
  const write: NodeJS.WriteStream["write"] = (chunk: string | Uint8Array, ...args: unknown[]) => {
    const output = typeof chunk === "string" && activeThemeId() !== "contrast"
      ? transform(chunk, stdout.columns, stdout.rows) : chunk;
    return Reflect.apply(stdout.write, stdout, [output, ...args]) as boolean;
  };
  return new Proxy(stdout, {
    get(target, property) {
      if (property === "write") return write;
      const value = Reflect.get(target, property, target);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
}
