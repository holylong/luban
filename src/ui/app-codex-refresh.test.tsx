import React from "react";
import { PassThrough } from "node:stream";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { stripVTControlCharacters } from "node:util";
import { render } from "ink";
import { afterEach, expect, it } from "vitest";
import { loadConfig } from "../core/config.js";
import { App } from "./app.js";

const originalHome = process.env.LUBAN_HOME;
const originalCodexHome = process.env.CODEX_HOME;
afterEach(() => {
  if (originalHome === undefined) delete process.env.LUBAN_HOME;
  else process.env.LUBAN_HOME = originalHome;
  if (originalCodexHome === undefined) delete process.env.CODEX_HOME;
  else process.env.CODEX_HOME = originalCodexHome;
});

/**
 * The Codex CLI rewrites `models_cache.json` whenever it refreshes its catalog.
 * A TUI that stays open for days used to keep the startup list, so a brand new
 * model was invisible until luban restarted; opening the model list now re-reads
 * the cache first.
 */
it("shows a model the Codex CLI published after the TUI started", async () => {
  const home = await mkdtemp(join(tmpdir(), "luban-codex-refresh-ui-"));
  const workspace = join(home, "workspace");
  await mkdir(workspace);
  process.env.LUBAN_HOME = home;
  process.env.CODEX_HOME = await mkdtemp(join(tmpdir(), "luban-codex-refresh-cache-"));

  const config = loadConfig({ workspace, model: "codex/default" });
  expect(config.models.some((model) => model.model === "gpt-8-sol")).toBe(false);

  // The CLI refreshes its catalog after this process has already loaded config.
  await writeFile(join(process.env.CODEX_HOME, "models_cache.json"), JSON.stringify({
    models: [
      { slug: "gpt-8-sol", display_name: "GPT-8-Sol", visibility: "list", supported_in_api: true,
        priority: 1, input_modalities: ["text", "image"] },
      { slug: "gpt-7-astra", display_name: "GPT-7-Astra", visibility: "list", supported_in_api: true,
        priority: 2, input_modalities: ["text"] },
    ],
  }));

  const stdin = Object.assign(new PassThrough(), { isTTY: true, setRawMode() {}, ref() {}, unref() {} });
  const stdout = Object.assign(new PassThrough(), { columns: 110, rows: 40, isTTY: true });
  let frame = "";
  stdout.on("data", (data) => { frame = stripVTControlCharacters(String(data)); });
  const app = render(<App config={config} />, {
    stdin: stdin as unknown as NodeJS.ReadStream, stdout: stdout as unknown as NodeJS.WriteStream,
    debug: true, patchConsole: false, exitOnCtrlC: false,
  });
  try {
    await expect.poll(() => frame, { timeout: 5000 }).toContain("Auto");
    stdin.write("/models");
    await new Promise((resolve) => setTimeout(resolve, 80));
    stdin.write("\r");
    await expect.poll(() => frame).toContain("Model providers");
    stdin.write("\r");
    await expect.poll(() => frame).toContain("Models · codex");
    // Newest first, using the CLI's display name instead of the raw slug.
    stdin.write("\u001b[B");
    await expect.poll(() => frame).toContain("› GPT-8-Sol");
    expect(frame).toContain("codex/gpt-8-sol");
    stdin.write("\u001b[B");
    await expect.poll(() => frame).toContain("› GPT-7-Astra");
    // The static fallbacks stay available behind the cached catalog.
    expect(frame).toContain("codex/gpt-6-astra");
  } finally {
    app.unmount();
  }
});
