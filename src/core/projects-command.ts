import { Command } from "commander";
import { join } from "node:path";
import { homedir } from "node:os";
import { forgetProjects, readProjects } from "./config.js";
import { workspaceProblem, type WorkspaceProblem } from "./project-registry.js";

export interface ProjectRow {
  project: string;
  workspace: string;
  /** `ok` for a usable directory, otherwise why it should not be listed. */
  state: "ok" | WorkspaceProblem;
}

export function projectRows(projects: Record<string, string>): ProjectRow[] {
  return Object.entries(projects)
    .map(([project, workspace]) => ({ project, workspace, state: workspaceProblem(workspace) ?? "ok" as const }))
    .sort((left, right) => (left.state === "ok") === (right.state === "ok")
      ? left.project.localeCompare(right.project)
      : left.state === "ok" ? -1 : 1);
}

const STATE_LABELS: Record<ProjectRow["state"], string> = {
  ok: "可用",
  transient: "临时目录，下次启动不会再显示",
  missing: "目录不存在",
};

/**
 * `luban projects` — what this machine advertises, and a way to forget the
 * registrations that only exist because a test or a probe once ran there.
 */
export async function runProjects(argv: string[], context: { home?: string } = {}): Promise<number> {
  const program = new Command();
  program
    .name("luban projects")
    .description("List registered workspaces and forget scratch or missing ones")
    .argument("[path]", "workspace directory (unused; kept for symmetry)", process.cwd())
    .option("--home <path>", "luban data directory", context.home || process.env.LUBAN_HOME || join(homedir(), ".luban"))
    .option("--prune", "forget registrations whose directory is temporary or gone")
    .option("--json", "print machine-readable rows")
    .showHelpAfterError();
  program.parse(argv, { from: "user" });
  const options = program.opts<{ home: string; prune?: boolean; json?: boolean }>();
  const rows = projectRows(await readProjects(options.home));
  const stale = rows.filter((row) => row.state !== "ok");
  const removed = options.prune ? await forgetProjects(options.home, stale.map((row) => row.project)) : [];
  if (options.json) {
    process.stdout.write(`${JSON.stringify({ home: options.home, rows: rows.filter((row) => !removed.includes(row.project)), removed }, null, 2)}\n`);
    return 0;
  }
  const usable = rows.filter((row) => !removed.includes(row.project));
  process.stdout.write(`${options.home}\n`);
  if (!usable.length) process.stdout.write("还没有注册的工作区。在手机上新建，或用 luban <目录> 启动一次。\n");
  for (const row of usable) process.stdout.write(`  ${row.project}\n    ${row.workspace}\n    ${STATE_LABELS[row.state]}\n`);
  if (removed.length) process.stdout.write(`\n已忘记 ${removed.length} 个：${removed.join("、")}\n`);
  else if (stale.length) process.stdout.write(`\n有 ${stale.length} 个无效登记（临时目录或目录不存在），运行 luban projects --prune 可清除。\n`);
  return 0;
}
