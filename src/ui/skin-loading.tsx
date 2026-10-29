import React, { useEffect, useMemo, useState } from "react";
import { existsSync, readFileSync } from "node:fs";
import { Box, Text } from "ink";
import { PNG } from "pngjs";
import { activeTheme, theme, type LoadingAnimation } from "./theme.js";

export type PetPixel = readonly [number, number, number, number];
export type PetFrame = PetPixel[][];
const WIDTH = 8;
const PIXEL_HEIGHT = 8;
export const PET_ROWS = PIXEL_HEIGHT / 4;
const CELL_COLUMNS = WIDTH / 2;
const cache = new Map<LoadingAnimation, PetFrame[] | null>();

/** Downsample with premultiplied alpha, preserving transparent sprite edges.
 * Frames share a scale and foot anchor so landing does not resize the pet. */
export function rasterizePet(image: { width: number; height: number; data: Uint8Array }, animation: LoadingAnimation): PetFrame[] {
  const maxWidth = Math.max(...animation.frames.map(rect => rect[2]));
  const maxHeight = Math.max(...animation.frames.map(rect => rect[3]));
  const scale = Math.min(WIDTH / maxWidth, PIXEL_HEIGHT / maxHeight);
  return animation.frames.map(([left, top, width, height]) => {
    const drawWidth = Math.max(1, Math.round(width * scale));
    const drawHeight = Math.max(1, Math.round(height * scale));
    const startX = Math.floor((WIDTH - drawWidth) / 2);
    const startY = PIXEL_HEIGHT - drawHeight;
    return Array.from({ length: PIXEL_HEIGHT }, (_, y) => Array.from({ length: WIDTH }, (_, x): PetPixel => {
      if (x < startX || x >= startX + drawWidth || y < startY) return [0, 0, 0, 0];
      const channels = [0, 0, 0];
      let alpha = 0;
      for (let sy = 0; sy < 4; sy++) for (let sx = 0; sx < 4; sx++) {
        const px = Math.min(image.width - 1, Math.floor((left + (x - startX + (sx + .5) / 4) / drawWidth * width) / 1280 * image.width));
        const py = Math.min(image.height - 1, Math.floor((top + (y - startY + (sy + .5) / 4) / drawHeight * height) / 1280 * image.height));
        const index = (py * image.width + px) * 4;
        const a = image.data[index + 3]! / 255;
        alpha += a;
        for (let c = 0; c < 3; c++) channels[c]! += image.data[index + c]! * a;
      }
      return alpha ? [Math.round(channels[0]! / alpha), Math.round(channels[1]! / alpha), Math.round(channels[2]! / alpha), alpha / 16] : [0, 0, 0, 0];
    }));
  });
}

export function loadPetFrames(animation: LoadingAnimation): PetFrame[] | null {
  if (cache.has(animation)) return cache.get(animation)!;
  let frames: PetFrame[] | null = null;
  try {
    const built = new URL(`../assets/${animation.asset}`, import.meta.url);
    const source = new URL(`../../assets/${animation.asset}`, import.meta.url);
    frames = rasterizePet(PNG.sync.read(readFileSync(existsSync(built) ? built : source)), animation);
  } catch { /* Missing artwork must never interrupt an agent run. */ }
  cache.set(animation, frames);
  return frames;
}

/** Braille preserves eight silhouette samples per cell without solid color blocks. */
export function petDotRows(frame: PetFrame): string[] {
  const bits = [[1, 8], [2, 16], [4, 32], [64, 128]];
  return Array.from({ length: PET_ROWS }, (_, row) =>
    Array.from({ length: CELL_COLUMNS }, (_, column) => {
      let mask = 0;
      for (let y = 0; y < 4; y++) for (let x = 0; x < 2; x++) {
        if ((frame[row * 4 + y]?.[column * 2 + x]?.[3] ?? 0) >= .35) mask |= bits[y]![x]!;
      }
      return mask ? String.fromCharCode(0x2800 + mask) : " ";
    }).join("")
  );
}

/** Mounted only during work or preview; no timer runs while the app is idle. */
export function SkinLoading() {
  const skin = activeTheme();
  const animation = skin.loadingAnimation;
  const frames = useMemo(() => animation ? loadPetFrames(animation) : null, [animation]);
  const [tick, setTick] = useState(0);
  const reduced = process.env.LUBAN_ANIMATION === "0" || process.env.INK_SCREEN_READER === "true";
  useEffect(() => {
    setTick(0);
    if (!animation || !frames?.length || reduced) return;
    const timer = setInterval(() => setTick(value => (value + 1) % frames.length), animation.intervalMs);
    return () => clearInterval(timer);
  }, [animation, frames, reduced]);
  if (!animation || !frames?.length) return null;
  if (process.env.INK_SCREEN_READER === "true") return <Text>{skin.label}</Text>;
  const index = tick % frames.length;
  const lines = petDotRows(frames[index]!);
  return <Box height={PET_ROWS} flexShrink={0} paddingLeft={1} overflow="hidden">
    <Box width={CELL_COLUMNS} height={PET_ROWS} flexDirection="column">
      {lines.map((line, y) => <Text key={y} color={theme.accent}>{line}</Text>)}
    </Box>
    <Box alignItems="flex-end" paddingLeft={1}><Text color={theme.accent}>{skin.label}</Text></Box>
  </Box>;
}
