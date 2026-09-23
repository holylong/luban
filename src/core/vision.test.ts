import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { openAiWireMessages } from "./openai.js";
import { attachImageTools } from "./vision.js";
import type { ChatMessage } from "./types.js";
import { isImagePath, mimeOfImagePath, resolveImageParts } from "./vision.js";

// 1x1 transparent PNG.
const TINY_PNG_BASE64 = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==";

describe("vision attachments", () => {
  it("detects image paths by extension", () => {
    expect(isImagePath("shot.png")).toBe(true);
    expect(isImagePath("photo.JPG")).toBe(true);
    expect(mimeOfImagePath("a.webp")).toBe("image/webp");
    expect(isImagePath("main.ts")).toBe(false);
  });

  it("inlines workspace images as OpenAI vision parts", async () => {
    const root = await mkdtemp(join(tmpdir(), "luban-vision-"));
    await writeFile(join(root, "shot.png"), Buffer.from(TINY_PNG_BASE64, "base64"));
    const wire = await openAiWireMessages([
      { role: "user", content: "what is this", images: [{ path: "shot.png", mime: "image/png" }] },
    ], root);
    const content = (wire[0] as { content: unknown }).content as Array<Record<string, unknown>>;
    expect(content[0]).toMatchObject({ type: "text" });
    expect(content[1]).toMatchObject({ type: "image_url" });
    expect(String((content[1]?.image_url as Record<string, unknown>).url)).toContain("data:image/png;base64,");
  });

  it("skips escapes and oversized files instead of failing the turn", async () => {
    const root = await mkdtemp(join(tmpdir(), "luban-vision-safe-"));
    const parts = await resolveImageParts(root, [
      { path: "../outside.png", mime: "image/png" },
      { path: "missing.png", mime: "image/png" },
    ]);
    expect(parts).toEqual([]);
  });

  it("lets the model attach images to the current request", async () => {
    const root = await mkdtemp(join(tmpdir(), "luban-vision-attach-"));
    await writeFile(join(root, "shot.png"), Buffer.from(TINY_PNG_BASE64, "base64"));
    const messages: ChatMessage[] = [{ role: "user", content: "look at this" }];
    const [attach] = attachImageTools(messages, root);
    const signal = new AbortController().signal;
    await expect(attach!.execute({ path: "shot.png" }, signal)).resolves.toContain("attached shot.png");
    expect(messages[0]?.images).toEqual([{ path: "shot.png", mime: "image/png" }]);
    // Duplicates collapse; non-images and escapes are rejected.
    await attach!.execute({ path: "shot.png" }, signal);
    expect(messages[0]?.images).toHaveLength(1);
    await expect(attach!.execute({ path: "main.ts" }, signal)).rejects.toThrow("supports png");
    await expect(attach!.execute({ path: "../outside.png" }, signal)).rejects.toThrow();
  });
});
