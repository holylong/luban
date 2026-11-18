import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { loadConfig } from "../core/config.js";
import { MeshRuntime } from "../core/mesh/runtime.js";
import { LubanWebServer } from "./server.js";

const originalHome = process.env.LUBAN_HOME;
const originalCodexHome = process.env.CODEX_HOME;

afterEach(() => {
  if (originalHome === undefined) delete process.env.LUBAN_HOME;
  else process.env.LUBAN_HOME = originalHome;
  if (originalCodexHome === undefined) delete process.env.CODEX_HOME;
  else process.env.CODEX_HOME = originalCodexHome;
});

interface NodeReply {
  model_id: string;
  model: string;
  models: Array<{ id: string; name: string; provider: string }>;
}

/**
 * Phones and the desktop console read the model list from `/api/node`. A long
 * running server used the startup catalog, so a model the Codex CLI published
 * later only showed up after restarting luban.
 */
describe("Codex catalog in /api/node", () => {
  it("re-reads the CLI model cache for every poll", async () => {
    const root = await mkdtemp(join(tmpdir(), "luban-web-codex-"));
    const workspace = join(root, "workspace");
    const codexHome = join(root, "codex");
    await mkdir(workspace, { recursive: true });
    await mkdir(codexHome, { recursive: true });
    process.env.LUBAN_HOME = join(root, "home");
    process.env.CODEX_HOME = codexHome;

    const config = loadConfig({ workspace, model: "codex/default" });
    const mesh = new MeshRuntime(config);
    await mesh.start();
    const web = new LubanWebServer(config, mesh, { port: 0 });
    const base = await web.start();
    try {
      const read = async (): Promise<NodeReply> => {
        const reply = await fetch(`${base}api/node`);
        expect(reply.status).toBe(200);
        return await reply.json() as NodeReply;
      };
      expect((await read()).models.some((model) => model.id === "codex/gpt-8-sol")).toBe(false);

      // The CLI refreshes its catalog while the server keeps running.
      await writeFile(join(codexHome, "models_cache.json"), JSON.stringify({
        models: [
          { slug: "gpt-8-sol", display_name: "GPT-8-Sol", visibility: "list", supported_in_api: true, priority: 1 },
          { slug: "gpt-7-astra", display_name: "GPT-7-Astra", visibility: "list", supported_in_api: true, priority: 2 },
        ],
      }));
      const after = await read();
      expect(after.models.find((model) => model.id === "codex/gpt-8-sol")).toMatchObject({
        name: "GPT-8-Sol", provider: "codex",
      });
      expect(after.models.find((model) => model.id === "codex/gpt-7-astra")).toMatchObject({ name: "GPT-7-Astra" });
      // Newest first, and the active selection is untouched.
      const codex = after.models.filter((model) => model.provider === "codex").map((model) => model.id);
      expect(codex.slice(0, 3)).toEqual(["codex/default", "codex/gpt-8-sol", "codex/gpt-7-astra"]);
      expect(after.model_id).toBe("codex/default");
      expect(after.model).toBe("default");
      // The working config the rest of the server uses is refreshed too.
      expect(config.models.some((model) => model.id === "codex/gpt-8-sol")).toBe(true);
    } finally {
      await web.stop();
      await mesh.stop();
      await rm(root, { recursive: true, force: true, maxRetries: 20, retryDelay: 25 });
    }
  }, 20_000);
});
