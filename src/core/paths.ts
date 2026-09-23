import { lstat, realpath } from "node:fs/promises";
import { isAbsolute, relative, resolve, sep } from "node:path";

export async function resolveInside(workspace: string, input: string): Promise<string> {
  const root = resolve(workspace);
  const target = resolve(root, input || ".");
  const rel = relative(root, target);
  if (isAbsolute(rel) || rel === ".." || rel.startsWith(`..${sep}`)) throw new Error(`path escapes workspace: ${input}`);
  const canonicalRoot = await realpath(root);
  let probe = target;
  for (;;) {
    try {
      const canonical = await realpath(probe);
      const canonicalRel = relative(canonicalRoot, canonical);
      if (isAbsolute(canonicalRel) || canonicalRel === ".." || canonicalRel.startsWith(`..${sep}`)) {
        throw new Error(`symlink escapes workspace: ${input}`);
      }
      break;
    } catch (error) {
      if (error instanceof Error && error.message.startsWith("symlink escapes")) throw error;
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      // realpath cannot resolve dangling links; never follow one on a later write.
      const info = await lstat(probe).catch((error: NodeJS.ErrnoException) => {
        if (error.code !== "ENOENT") throw error;
        return undefined;
      });
      if (info?.isSymbolicLink()) throw new Error(`unresolved symlink path: ${input}`);
      const parent = resolve(probe, "..");
      if (parent === probe) throw error;
      probe = parent;
    }
  }
  return target;
}
