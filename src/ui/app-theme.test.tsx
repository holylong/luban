import React from "react";
import { PassThrough } from "node:stream";
import { mkdir, mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { stripVTControlCharacters } from "node:util";
import { render } from "ink";
import { afterEach, expect, it } from "vitest";
import { loadConfig } from "../core/config.js";
import { App } from "./app.js";
import { activeThemeId, applyTheme, THEMES, theme } from "./theme.js";

const originalHome = process.env.LUBAN_HOME;

afterEach(() => {
  // The palette is module state shared by every view in this test file.
  applyTheme("midnight");
  if (originalHome === undefined) delete process.env.LUBAN_HOME;
  else process.env.LUBAN_HOME = originalHome;
});

/**
 * `/theme` is the only way to change the color scheme without a restart, so the
 * test drives the real TUI: the picker must list the catalog, a name must
 * repaint the shared palette, and the choice must survive the next start.
 */
it("lists the palettes, switches on a name, and persists the choice", async () => {
  const home = await mkdtemp(join(tmpdir(), "luban-theme-ui-"));
  const workspace = join(home, "workspace");
  await mkdir(workspace);
  process.env.LUBAN_HOME = home;
  const config = loadConfig({ workspace });
  expect(config.theme).toBe("midnight");

  const stdin = Object.assign(new PassThrough(), { isTTY: true, setRawMode() {}, ref() {}, unref() {} });
  const stdout = Object.assign(new PassThrough(), { columns: 110, rows: 40, isTTY: true });
  let frame = "";
  stdout.on("data", (data) => {
    const text = stripVTControlCharacters(String(data));
    if (text.includes("Auto")) frame = text;
  });
  const app = render(<App config={config} />, {
    stdin: stdin as unknown as NodeJS.ReadStream, stdout: stdout as unknown as NodeJS.WriteStream,
    debug: true, patchConsole: false, exitOnCtrlC: false,
  });
  // Enter submits only once the composer owns the keystrokes: writing text and
  // the return in the same tick loses the submit to Ink's own mount pass.
  const type = async (text: string): Promise<void> => {
    stdin.write(text);
    await new Promise((resolve) => setTimeout(resolve, 80));
    stdin.write("\r");
  };
  try {
    await expect.poll(() => frame, { timeout: 5000 }).toContain("Auto");
    await new Promise((resolve) => setTimeout(resolve, 300));

    // 1. Bare `/theme` is a picker: every scheme is offered with its own swatches.
    await type("/theme");
    await expect.poll(() => frame).toContain("主题 · midnight");
    expect(frame).toContain("nord");
    // Ids are what a user types, and the light schemes are marked as such.
    expect(frame).toContain("tokyo-night");
    expect(frame).toContain("即时切换并写入");
    // The catalog is longer than a terminal, so the list is windowed and says so
    // rather than silently dropping the schemes past the bottom edge.
    expect(frame).toContain("↓ 还有 2 个配色");
    expect(frame).not.toContain("↑ 还有");

    // Scrolling to the end keeps the highlighted row on screen: the palette is
    // previewed by arrow keys, so a selection below the fold would be chosen blind.
    for (let press = 0; press < THEMES.length - 1; press += 1) stdin.write("\u001b[B");
    await expect.poll(() => frame).toContain("主题 · github-light");
    expect(frame).toContain("▸ github-light");
    expect(frame).toContain("↑ 还有");
    expect(frame).not.toContain("↓ 还有");
    expect(frame).toContain("亮色");
    stdin.write("\u001b");
    await expect.poll(() => frame).not.toContain("主题 · ");
    expect(activeThemeId()).toBe("midnight");

    // 2. Esc returns to the transcript without changing anything.
    stdin.write("\u001b");
    await expect.poll(() => frame).not.toContain("主题 · midnight");
    expect(activeThemeId()).toBe("midnight");

    // 3. The picker is navigated, not just printed: the arrow keys repaint the
    // workbench as they move, so the scheme is chosen by looking at it. Only
    // Enter commits - Esc must put back the palette the user scrolled away from.
    const preferences = join(home, "node-preferences.json");
    const savedTheme = async (): Promise<string> => await readFile(preferences, "utf8").catch(() => "");
    await type("/theme");
    await expect.poll(() => frame).toContain("主题 · midnight");
    stdin.write("\u001b[B");
    await expect.poll(() => frame).toContain("主题 · nord");
    expect(activeThemeId()).toBe("nord");
    expect(theme.background).toBe("#2e3440");
    stdin.write("\u001b[B");
    await expect.poll(() => frame).toContain("主题 · dracula");
    // The cursor runs backwards too.
    stdin.write("\u001b[A");
    await expect.poll(() => frame).toContain("主题 · nord");
    // Previewing alone never writes the preference file.
    expect(await savedTheme()).not.toContain("theme");
    stdin.write("\u001b");
    await expect.poll(() => frame).not.toContain("主题 · ");
    expect(activeThemeId()).toBe("midnight");
    expect(theme.background).toBe("#0b0f14");

    // 4. Enter takes the highlighted row, so the choice survives a restart.
    await type("/theme");
    await expect.poll(() => frame).toContain("主题 · midnight");
    stdin.write("\u001b[B");
    await expect.poll(() => frame).toContain("主题 · nord");
    stdin.write("\r");
    await expect.poll(() => frame).not.toContain("主题 · ");
    expect(activeThemeId()).toBe("nord");
    await expect.poll(savedTheme).toContain('"theme": "nord"');

    // 5. A name switches directly; a light scheme is reachable by alias, and it
    // really is a bright canvas.
    await type("/theme light");
    await expect.poll(() => frame).toContain("主题 github-light");
    expect(theme.background).toBe("#ffffff");

    // 6. A typo is refused with the list of valid names instead of a blank UI.
    await type("/theme neon-disco");
    await expect.poll(() => frame).toContain("未知主题 neon-disco");
    expect(frame).toContain("midnight");
    expect(activeThemeId()).toBe("github-light");

    // 7. `/settings` reports the active scheme so the state is never a guess.
    await type("/settings");
    await expect.poll(() => frame).toContain("theme github-light");
  } finally {
    app.unmount();
    app.cleanup();
  }
}, 20000);
