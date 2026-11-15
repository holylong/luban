import { statSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve, sep } from "node:path";

/**
 * Scratch roots that never hold a durable workspace.
 *
 * Every probe, smoke test and one-off `luban web /tmp/...` registers whatever
 * directory it was pointed at, and those registrations survive the run: the
 * phone then lists a dozen `luban-term-*` entries that no longer exist. A
 * workspace under one of these roots is always an artifact.
 */
export function transientRoots(): string[] {
  return [...new Set([tmpdir(), "/tmp", "/private/tmp", "/var/folders", "/private/var/folders"].map((root) => resolve(root)))];
}

export type WorkspaceProblem = "transient" | "missing";

/** True for a path under an OS scratch root: a test or probe artifact, never a workspace. */
export function isTransientWorkspace(path: string): boolean {
  const target = resolve(path);
  for (const root of transientRoots()) {
    if (target === root || target.startsWith(root + sep)) return true;
  }
  return false;
}

/** Why a registered workspace cannot be offered, or undefined when it can. */
export function workspaceProblem(path: string): WorkspaceProblem | undefined {
  if (isTransientWorkspace(path)) return "transient";
  const target = resolve(path);
  try {
    if (!statSync(target).isDirectory()) return "missing";
  } catch {
    return "missing";
  }
  return undefined;
}

/**
 * The projects a phone or a peer may be offered.
 *
 * `keep` is the project this node is running right now: it stays even when its
 * directory is momentarily unavailable or (during a probe) lives under temp,
 * because hiding the workspace on screen while its own session is open reads as
 * "my workspace disappeared".
 */
export function visibleProjects(projects: Record<string, string>,
  options: { keep?: string; workspace?: string; allowTransient?: boolean } = {}): Record<string, string> {
  const kept: Record<string, string> = {};
  for (const [name, raw] of Object.entries(projects)) {
    if (typeof raw !== "string" || !raw) continue;
    if (name === options.keep || (options.workspace && resolve(raw) === resolve(options.workspace))) {
      kept[name] = raw;
      continue;
    }
    const problem = workspaceProblem(raw);
    if (problem === "transient" && options.allowTransient) {
      kept[name] = raw;
      continue;
    }
    if (problem) continue;
    kept[name] = raw;
  }
  return kept;
}

/**
 * Drop scratch-path entries from a registry snapshot.
 *
 * A relay stores what each machine last reported, and it cannot stat another
 * machine's disk; but a `/private/var/folders/.../luban-term-*` path is a probe
 * artifact wherever it lives. Used when persisting a snapshot and again when
 * reading an old one that was stored before this filter existed.
 */
export function durableProjects(projects: Record<string, string>): Record<string, string> {
  return Object.fromEntries(Object.entries(projects)
    .filter(([, path]) => typeof path === "string" && path && !isTransientWorkspace(path)));
}
