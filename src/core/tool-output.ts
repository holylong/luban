import { randomUUID } from "node:crypto";
import { mkdir, open, readdir, stat, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { clipContextText } from "./context.js";
import type { ToolDefinition } from "./types.js";

const PREVIEW_CHARS = 24_000;
const PAGE_BYTES = 16_000;

/** Keep full observations outside model context; UUID references survive resume. */
export class ToolOutputStore {
  private readonly root: string;
  private prunedAt = 0;
  constructor(home: string) { this.root = join(home, "tool-output-node"); }

  async capture(output: string, retentionDays = 7, maxBytes = 500 * 1024 * 1024): Promise<string> {
    if (output.length <= PREVIEW_CHARS) return output;
    const id = randomUUID();
    await mkdir(this.root, { recursive: true, mode: 0o700 });
    await writeFile(join(this.root, `${id}.txt`), output, { encoding: "utf8", mode: 0o600, flag: "wx" });
    // Best-effort retention: throttled to one scan per minute so hot loops stay fast.
    const now = Date.now();
    if (now - this.prunedAt > 60_000) {
      this.prunedAt = now;
      await this.prune(retentionDays, maxBytes).catch(() => undefined);
    }
    const reference = `[Full output saved: ${id}; use read_tool_output with output_id and byte offset. Total ${Buffer.byteLength(output)} bytes.]`;
    // Repeat the reference at the tail so subsequent head/tail compaction keeps it.
    return `${reference}\n${clipContextText(output, PREVIEW_CHARS)}\n${reference}`;
  }

  /** Delete archives older than retentionDays, then oldest-first until under maxBytes. */
  async prune(retentionDays = 7, maxBytes = 500 * 1024 * 1024): Promise<{ removed: number; bytes: number }> {
    let entries: string[] = [];
    try {
      entries = (await readdir(this.root)).filter((name) => name.endsWith(".txt"));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return { removed: 0, bytes: 0 };
      throw error;
    }
    const cutoff = Date.now() - Math.max(1_000 / 86_400_000, retentionDays) * 86_400_000;
    const stats = await Promise.all(entries.map(async (name) => {
      try {
        const info = await stat(join(this.root, name));
        return { name, size: info.size, mtime: info.mtimeMs };
      } catch {
        return null;
      }
    }));
    const valid = stats.filter((item): item is { name: string; size: number; mtime: number } => item !== null);
    let removed = 0;
    let bytes = 0;
    for (const item of valid.filter((item) => item.mtime < cutoff)) {
      try {
        await unlink(join(this.root, item.name));
        removed += 1;
        bytes += item.size;
      } catch { /* concurrent prune or active read; skip */ }
    }
    const remaining = valid.filter((item) => item.mtime >= cutoff).sort((a, b) => a.mtime - b.mtime);
    let total = remaining.reduce((sum, item) => sum + item.size, 0);
    for (const item of remaining) {
      if (total <= maxBytes) break;
      try {
        await unlink(join(this.root, item.name));
        removed += 1;
        bytes += item.size;
        total -= item.size;
      } catch { /* skip */ }
    }
    return { removed, bytes };
  }

  tool(): ToolDefinition {
    return {
      name: "read_tool_output",
      description: "Read a byte page of an archived tool result without re-running the original command. Use the output_id from a truncated result. Offsets are UTF-8 bytes, not lines.",
      risk: "read", parallelSafe: true,
      parameters: {
        type: "object", additionalProperties: false, required: ["output_id"],
        properties: {
          output_id: { type: "string" },
          offset: { type: "integer", minimum: 0 },
          limit: { type: "integer", minimum: 1, maximum: PAGE_BYTES },
        },
      },
      execute: async (args, signal) => {
        signal.throwIfAborted();
        if (typeof args.output_id !== "string" || !/^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i.test(args.output_id)) {
          throw new Error("output_id must be the UUID of an archived tool result");
        }
        const offset = args.offset ?? 0;
        const limit = args.limit ?? PAGE_BYTES;
        if (typeof offset !== "number" || !Number.isSafeInteger(offset) || offset < 0) throw new Error("offset must be a nonnegative integer");
        if (typeof limit !== "number" || !Number.isSafeInteger(limit) || limit < 1 || limit > PAGE_BYTES) throw new Error(`limit must be between 1 and ${PAGE_BYTES}`);
        const file = await open(join(this.root, `${args.output_id}.txt`), "r");
        try {
          const size = (await file.stat()).size;
          // A page may extend by up to 3 bytes to finish a UTF-8 character.
          const buffer = Buffer.alloc(limit + 3);
          const { bytesRead } = await file.read(buffer, 0, buffer.length, offset);
          let end = Math.min(limit, bytesRead);
          while (end < bytesRead && (buffer[end]! & 0xc0) === 0x80) end += 1;
          let start = 0;
          while (start < end && (buffer[start]! & 0xc0) === 0x80) start += 1;
          return JSON.stringify({ output_id: args.output_id, offset, next_offset: offset + end,
            total_bytes: size, eof: offset + end >= size, content: buffer.subarray(start, end).toString("utf8") });
        } finally { await file.close(); }
      },
    };
  }
}
