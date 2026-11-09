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

export function mobileProject(node: WorkspaceInfo, current: string): string {
  const projects = mobileProjects(node);
  return Object.hasOwn(projects, current) ? current : node.project || Object.keys(projects)[0] || "";
}
