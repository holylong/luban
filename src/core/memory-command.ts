import { Command } from "commander";
import { homedir } from "node:os";
import { resolve, join } from "node:path";
import {
  clearProjectMemory, listProjectMemories, memoryFile, memoryStamp, readProjectMemory, renderMemory,
  type MemoryEntry, type ProjectMemoryRecord,
} from "./memory.js";

/**
 * `luban memory` — read and clear the per-project memory that Creator tasks now
 * carry between runs.
 *
 * The file is plain Markdown on purpose, so this is a convenience, not the only
 * door: a person can open it in an editor. The command exists because the window
 * needs a machine-readable list (the child process owns the parsing rules) and
 * because "what does it remember about this folder?" should not require knowing
 * where the hash-named file landed.
 */
export interface MemoryListing {
  project: string;
  workspace: string;
  file: string;
  facts: MemoryEntry[];
  runs: MemoryEntry[];
}

function listing(home: string, record: ProjectMemoryRecord): MemoryListing {
  return { project: record.project, workspace: record.workspace, file: memoryFile(home, record.workspace), facts: record.facts, runs: record.runs };
}

function describe(record: MemoryListing): string {
  const newest = Math.max(0, ...record.facts.map(item => item.at), ...record.runs.map(item => item.at));
  const when = newest ? `最近 ${memoryStamp(newest)}` : "还没有时间戳";
  return `${record.project}  ${record.workspace}\n  事实 ${record.facts.length} · 记录 ${record.runs.length} · ${when}\n  ${record.file}`;
}

/**
 * @param argv Arguments after `luban memory`.
 * @returns Process exit code.
 */
export async function runMemory(argv: string[]): Promise<number> {
  const program = new Command();
  program
    .name("luban memory")
    .description("Show or clear what luban remembers about a project (one Markdown file per workspace)")
    .argument("[workspace]", "show this project's memory instead of the list")
    .option("--json", "machine-readable output for the Creator window")
    .option("--clear", "remove the memory of the given workspace")
    .option("--all", "with --clear: remove every project's memory")
    .option("--home <path>", "luban data directory", process.env.LUBAN_HOME || join(homedir(), ".luban"))
    .showHelpAfterError();
  program.parse(argv, { from: "user" });
  const options = program.opts<{ json?: boolean; clear?: boolean; all?: boolean; home: string }>();
  const home = resolve(options.home);

  if (options.clear) {
    if (options.all) {
      const records = await listProjectMemories(home);
      for (const record of records) await clearProjectMemory(home, record.workspace);
      process.stdout.write(records.length ? `已清除 ${records.length} 个项目的记忆\n` : "本来就没有任何记忆\n");
      return 0;
    }
    const workspace = program.args[0];
    if (!workspace) {
      // Never guess: a bare `--clear` that silently picked a project would be
      // the one destructive default in this codebase.
      process.stderr.write("用法：luban memory --clear <workspace>  或  luban memory --clear --all\n");
      return 1;
    }
    const record = await readProjectMemory(home, workspace);
    await clearProjectMemory(home, workspace);
    process.stdout.write(`已清除 ${record.project}（${record.workspace}）的记忆：事实 ${record.facts.length} 条、记录 ${record.runs.length} 条\n`);
    return 0;
  }

  const target = program.args[0];
  if (target) {
    const record = await readProjectMemory(home, target);
    if (!record.facts.length && !record.runs.length) {
      process.stderr.write(`${record.workspace} 还没有记忆。任务里说「记住…」，或让它调用 remember 工具。\n`);
      return 1;
    }
    process.stdout.write(options.json ? `${JSON.stringify(listing(home, record), null, 2)}\n` : renderMemory(record));
    return 0;
  }

  const records = (await listProjectMemories(home)).map(record => listing(home, record));
  if (options.json) {
    process.stdout.write(`${JSON.stringify(records, null, 2)}\n`);
    return 0;
  }
  if (!records.length) {
    process.stdout.write("还没有任何记忆。任务里说「记住…」，或让它调用 remember 工具。\n");
    return 0;
  }
  process.stdout.write(`${records.map(describe).join("\n\n")}\n`);
  return 0;
}
