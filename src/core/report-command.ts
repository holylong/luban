import { Command } from "commander";
import { loadConfig } from "./config.js";
import { exportWorkReport, type ReportPeriod, type ReportSource } from "./work-report.js";
import { VERSION } from "../version.js";

export async function runReport(argv: string[]): Promise<number> {
  const program = new Command().name("luban report").description("Export local work reports across all projects and sessions").version(VERSION)
    .argument("[period]", "daily | weekly | monthly | yearly", "daily")
    .option("--date <YYYY-MM-DD>", "anchor date in the local timezone")
    .option("--sources <list>", "comma-separated luban,codex,claude,opencode")
    .option("--format <format>", "markdown | json", "markdown")
    .option("-o, --output <file>", "new output file (existing files are never overwritten)")
    .option("--codex-home <path>", "Codex data root")
    .option("--claude-home <path>", "Claude Code config root")
    .option("--opencode-home <path>", "OpenCode data root");
  program.parse(argv, { from: "user" });
  const opts = program.opts();
  try {
    const config = loadConfig({ workspace: process.cwd() });
    const result = await exportWorkReport({ ...opts, lubanHome: config.home, period: program.args[0] as ReportPeriod, sources: opts.sources?.split(",").map((s: string) => s.trim()) as ReportSource[] | undefined });
    process.stdout.write(`已导出 ${result.report.sessions.length} 个会话：${result.path}\n`);
    for (const warning of result.report.warnings) process.stderr.write(`${warning}\n`);
    return 0;
  } catch (e) { process.stderr.write(`报告导出失败：${String(e)}\n`); return 1; }
}
