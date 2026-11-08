import type { NodeInfo } from "./types";

type WorkspaceInfo = Pick<NodeInfo, "project" | "workspace" | "projects">;

/** Use the running PC workspace, never the first entry in a copied config. */
export function mobileProjects(node?: WorkspaceInfo): Record<string, string> {
  if (!node) return {};
  if (node.project && node.workspace) return { [node.project]: node.workspace };
  return node.projects ?? {};
}

export function mobileProject(node: WorkspaceInfo, current: string): string {
  const projects = mobileProjects(node);
  return Object.hasOwn(projects, current) ? current : node.project || Object.keys(projects)[0] || "";
}
