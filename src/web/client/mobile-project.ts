import type { NodeInfo } from "./types";

type WorkspaceInfo = Pick<NodeInfo, "project" | "workspace" | "projects">;

/**
 * Put the running PC workspace first, but keep other registered projects so a
 * directory added from the phone survives the next `/api/node` refresh.
 */
export function mobileProjects(node?: WorkspaceInfo): Record<string, string> {
  if (!node) return {};
  const projects = { ...(node.projects ?? {}) };
  if (node.project && node.workspace) {
    delete projects[node.project];
    return { [node.project]: node.workspace, ...projects };
  }
  return projects;
}

/**
 * True for a workspace directory that is an OS scratch artifact.
 *
 * Older computers keep advertising whatever a probe or a test once opened
 * (`/private/var/folders/.../luban-term-*`), and every one of those reads as a
 * real workspace on the phone. The server drops them when it is new enough;
 * this keeps an older node from filling the list in the meantime.
 */
export function scratchWorkspace(path: string): boolean {
  const value = path.replace(/\\/g, "/").replace(/\/+$/, "");
  return /^\/(?:private\/)?(?:tmp|var\/folders)(?:\/|$)/.test(value)
    || /^[A-Za-z]:\/(?:Windows\/Temp|Users\/[^/]+\/AppData\/Local\/Temp)(?:\/|$)/i.test(value);
}

export function mobileProject(node: WorkspaceInfo, current: string): string {
  const projects = mobileProjects(node);
  return Object.hasOwn(projects, current) ? current : node.project || Object.keys(projects)[0] || "";
}
