import { createHash } from "node:crypto";
import { readFile, realpath, stat } from "node:fs/promises";
import { dirname, join, relative, resolve, sep } from "node:path";
import { resolveInside } from "./paths.js";
import type { ChatMessage } from "./types.js";

const PREFIX = "luban_scope_";

/** Read subdirectory rules without following a symlink out of the workspace. */
export async function scopedInstructions(workspace: string, paths: string[], history: ChatMessage[] = []): Promise<ChatMessage[]> {
  if (!paths.length) return [];
  const root = resolve(workspace);
  const canonicalRoot = await realpath(root);
  const directories = new Set<string>();
  for (const path of paths) {
    const target = await resolveInside(root, path);
    // Consider both alias and canonical paths for internal symlinks.
    const targets = new Set([target]);
    try { targets.add(resolve(root, relative(canonicalRoot, await realpath(target)))); } catch { /* new file */ }
    for (const file of targets) {
      let directory = dirname(file);
      while (directory !== root && !relative(root, directory).startsWith("..")) {
        directories.add(directory);
        directory = dirname(directory);
      }
    }
  }
  const messages: ChatMessage[] = [];
  for (const directory of [...directories].sort((a, b) => a.split(sep).length - b.split(sep).length || a.localeCompare(b))) {
    for (const name of ["CLAUDE.md", "AGENTS.md"]) {
      const file = join(directory, name);
      await resolveInside(root, file);
      const path = relative(root, file).split(sep).join("/");
      const key = PREFIX + createHash("sha256").update(path).digest("hex").slice(0, 20);
      let content: string;
      try {
        const info = await stat(file);
        if (info.size > 64_000) throw new Error(`instruction file exceeds 64 KB: ${relative(root, file)}`);
        content = await readFile(file, "utf8");
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") {
          if (history.some((message) => message.name === key)) {
            messages.push({ role: "system", name: key, content: `[Scoped workspace instructions: ${path}]\nThis file no longer exists. Its previous instructions no longer apply.` });
          }
          continue;
        }
        throw error;
      }
      messages.push({ role: "system", name: key,
        content: `[Scoped workspace instructions: ${path}]\nApplies only to ${relative(root, directory).split(sep).join("/")}/ and descendants. More specific directory rules take precedence.\n${content}` });
    }
  }
  return messages;
}

export function instructionSnapshot(messages: ChatMessage[]): Set<string> {
  return new Set(messages.filter((message) => message.name?.startsWith(PREFIX)).map((message) => `${message.name}:${message.content}`));
}

export function attachInstructions(messages: ChatMessage[], instructions: ChatMessage[]): void {
  for (const instruction of instructions) {
    const index = messages.findIndex((message) => message.name === instruction.name);
    if (index >= 0) messages[index] = instruction;
    else {
      const boundary = messages.findIndex((message) => message.role !== "system");
      messages.splice(boundary < 0 ? messages.length : boundary, 0, instruction);
    }
  }
}

export function toolPaths(name: string, args: Record<string, unknown>): string[] {
  if (["read_file", "write_file", "edit_file", "code_intelligence"].includes(name) && typeof args.path === "string") return [args.path];
  if (name !== "apply_patch" || typeof args.patch !== "string") return [];
  return args.patch.split(/\r?\n/).filter((line) => /^(---|\+\+\+) /.test(line))
    .map((line) => line.slice(4).split("\t")[0]!.trim()).filter((path) => path !== "/dev/null")
    .map((path) => path.replace(/^"(.*)"$/, "$1").replace(/^[ab]\//, ""));
}
