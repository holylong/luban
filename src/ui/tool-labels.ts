/**
 * Human labels for tool calls.
 *
 * Shared so a tool that arrived over the mesh is named the same way as one that
 * ran locally; the map covers every tool the runtime actually registers, which
 * is what the live tool rows and the approval prompt read from.
 */
export const TOOL_LABELS: Record<string, string> = {
  read_file: "Read", write_file: "Write", edit_file: "Edit", apply_patch: "Patch",
  list_dir: "List", glob_files: "Glob", grep_files: "Search",
  bash: "Shell", get_background_task: "Background", stop_background_task: "Stop", send_background_input: "Input",
  read_image: "Image", web_fetch: "Fetch",
  git_context: "Git", create_checkpoint: "Checkpoint", restore_checkpoint: "Restore",
  list_skills: "Skills", read_skill: "Skill",
  mcp_list_tools: "MCP", mcp_search_tools: "MCP", mcp_call: "MCP",
  update_plan: "Plan", read_plan: "Plan",
  record_verification: "Verify", read_verification: "Verify",
  mesh_get_peers: "Mesh", mesh_ping: "Mesh", mesh_get_status: "Mesh", mesh_message: "Mesh",
  mesh_handoff: "Handoff", mesh_ask_all: "Mesh", mesh_sync_push: "Sync", mesh_sync_pull: "Sync",
  mesh_get_jobs: "Mesh", mesh_cancel_job: "Mesh", mesh_resume_job: "Mesh", mesh_poll_job: "Mesh",
};

export function toolLabel(name: string): string {
  return TOOL_LABELS[name] ?? name.replaceAll("_", " ");
}
