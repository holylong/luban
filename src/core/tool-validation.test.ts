import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createTools } from "./tools.js";
import { validateToolArguments } from "./tool-validation.js";
import type { LubanConfig, ToolDefinition } from "./types.js";

const roots: string[] = [];
const handles: ToolDefinition[] = [];
afterEach(async () => {
  for (const tool of handles.splice(0)) tool.close?.();
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 25 })));
});
async function fixture() {
  const workspace = await mkdtemp(join(tmpdir(), "luban-validation-")); roots.push(workspace);
  const tools = createTools({ workspace, home: workspace, project: "test", model: { name: "test" } } as LubanConfig);
  handles.push(...tools.values());
  await writeFile(join(workspace, "valuable.txt"), "valuable content\n");
  return { workspace, tools, signal: new AbortController().signal };
}

describe("tool argument contracts", () => {
  it("rejects missing and mistyped write content without touching the file", async () => {
    const { workspace, tools, signal } = await fixture();
    for (const content of [undefined, null, 42, false, {}]) {
      await expect(tools.get("write_file")!.execute({ path: "valuable.txt", content }, signal)).rejects.toThrow("invalid arguments");
      expect(await readFile(join(workspace, "valuable.txt"), "utf8")).toBe("valuable content\n");
    }
  });
  it("rejects a missing replacement, but permits explicit deletion and empty files", async () => {
    const { workspace, tools, signal } = await fixture();
    await expect(tools.get("edit_file")!.execute({ path: "valuable.txt", old_text: "valuable" }, signal)).rejects.toThrow("new_text");
    expect(await readFile(join(workspace, "valuable.txt"), "utf8")).toBe("valuable content\n");
    await tools.get("edit_file")!.execute({ path: "valuable.txt", old_text: "valuable", new_text: "" }, signal);
    expect(await readFile(join(workspace, "valuable.txt"), "utf8")).toBe(" content\n");
    await tools.get("write_file")!.execute({ path: "valuable.txt", content: "" }, signal);
    expect(await readFile(join(workspace, "valuable.txt"), "utf8")).toBe("");
  });
  it("refuses a cancelled write even through direct tool invocation", async () => {
    const { workspace, tools } = await fixture();
    const cancelled = new AbortController(); cancelled.abort(new Error("cancelled"));
    await expect(tools.get("write_file")!.execute({ path: "valuable.txt", content: "damage" }, cancelled.signal)).rejects.toThrow("cancelled");
    expect(await readFile(join(workspace, "valuable.txt"), "utf8")).toBe("valuable content\n");
  });
  it("validates nested schemas, references, enums, bounds and unknown properties without coercion", () => {
    const tool = { name: "contract", parameters: {
      type: "object", additionalProperties: false, required: ["tasks"],
      definitions: { task: { type: "object", additionalProperties: false, required: ["mode", "count"], properties: {
        mode: { enum: ["read", "write"] }, count: { type: "integer", minimum: 1, maximum: 3 },
      } } }, properties: { tasks: { type: "array", minItems: 1, maxItems: 2, items: { $ref: "#/definitions/task" } } },
    } } as ToolDefinition;
    const args = { tasks: [{ mode: "read", count: 2 }] };
    expect(() => validateToolArguments(tool, args)).not.toThrow();
    for (const bad of [{ tasks: [] }, { tasks: [{ mode: "shell", count: 1 }] }, { tasks: [{ mode: "read", count: "2" }] }, { tasks: [{ mode: "read", count: 4 }] }, { ...args, hidden: true }]) {
      expect(() => validateToolArguments(tool, bad)).toThrow("invalid arguments");
    }
    expect(args).toEqual({ tasks: [{ mode: "read", count: 2 }] });
  });
  it.each(["2019-09", "2020-12"])("supports the %s schema draft advertised by external tools", draft => {
    const tool = { name: "external", parameters: {
      $schema: `https://json-schema.org/draft/${draft}/schema`, type: "object",
      properties: { value: { anyOf: [{ type: "string" }, { type: "null" }] } }, required: ["value"],
    } } as ToolDefinition;
    expect(() => validateToolArguments(tool, { value: null })).not.toThrow();
    expect(() => validateToolArguments(tool, { value: 3 })).toThrow("invalid arguments");
  });
  it("refuses asynchronous schemas rather than treating a validation promise as approval", () => {
    const tool = { name: "external", parameters: { $async: true, type: "object", required: ["value"] } } as ToolDefinition;
    expect(() => validateToolArguments(tool, {})).toThrow("asynchronous validation is not supported");
  });
});
