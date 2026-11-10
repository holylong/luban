import type { FileEntry } from "./types";

/**
 * Which folders a reload has to read. The explorer caches one listing per
 * folder, so refreshing only the root left an expanded folder showing files
 * that no longer existed — or hiding files that had just been created.
 */
export function reloadPaths(expanded: Record<string, boolean>): string[] {
  return ["", ...Object.keys(expanded).filter(path => expanded[path]).sort()];
}

/** Skip a state write when a poll returns exactly what is already rendered. */
export function sameTree(previous: FileEntry[] | undefined, next: FileEntry[]): boolean {
  if (!previous || previous.length !== next.length) return false;
  return previous.every((entry, index) => {
    const other = next[index]!;
    return entry.name === other.name && entry.path === other.path && entry.type === other.type && entry.size === other.size;
  });
}
