import { lstat, realpath } from "node:fs/promises";
import { isAbsolute, relative, resolve, sep } from "node:path";

/** Whether an already-resolved path stays inside the workspace root. */
export function isInside(workspace: string, target: string): boolean {
  const rel = relative(resolve(workspace), resolve(target));
  return !isAbsolute(rel) && rel !== ".." && !rel.startsWith(`..${sep}`);
}

/**
 * Path resolution for the file tools. The workspace jail is the default; with
 * `sandbox.allowOutsideWorkspace` the file tools accept absolute and `..`
 * paths too, which is what the shell already did under that flag. Everything
 * inside the workspace still goes through the symlink checks of resolveInside.
 */
export function pathResolver(workspace: string, allowOutsideWorkspace = false): (input: string) => Promise<string> {
  const root = resolve(workspace);
  if (!allowOutsideWorkspace) return (input: string) => resolveInside(root, input);
  return async (input: string) => {
    const target = resolve(root, input || ".");
    if (!isInside(root, target)) return target;
    return resolveInside(root, target);
  };
}

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
