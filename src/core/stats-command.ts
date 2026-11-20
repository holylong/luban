import { Command } from "commander";
import { loadConfig } from "./config.js";
import { VERSION } from "../version.js";
import { DEFAULT_USAGE_STATS_URL } from "./service-defaults.js";
import { flushUsageStats, readUsageLedger, usageLedgerPath } from "./usage-stats.js";

/** `12345678` -> `12,345,678`, stable regardless of locale. */
function format(value: number): string {
  return value.toLocaleString("en-US");
}

function stamp(at: number): string {
  if (!at) return "暂无";
  return new Date(at).toLocaleString("zh-CN", { hour12: false });
}

/**
 * `luban stats` — the local token ledger, and the manual push that makes the
 * dashboard catch up *now*. The client only uploads on its own schedule (15
 * minutes by default), so "I ran a session, why is the board stale?" is
 * answered by this command rather than by waiting.
 *
 * @param argv Arguments after `luban stats`.
 * @returns Process exit code.
 */
export async function runStats(argv: string[]): Promise<number> {
  const program = new Command();
  program
    .name("luban stats")
    .description("Show the local token ledger and upload it now")
    .version(VERSION)
    .argument("[path]", "workspace directory", process.cwd())
    .option("--push", "upload the pending delta immediately, ignoring the interval")
    .option("--json", "print the ledger as JSON")
    .showHelpAfterError();
  program.parse(argv, { from: "user" });
  const workspace = (program.args[0] ?? process.cwd()) as string;
  const options = program.opts<{ push?: boolean; json?: boolean }>();
  const config = loadConfig({ workspace });
  const settings = config.usageStats;
  const ledger = readUsageLedger(config.home);
  const url = settings.url || DEFAULT_USAGE_STATS_URL;

  if (options.json) {
    process.stdout.write(`${JSON.stringify({ ledger, enabled: settings.enabled, intervalHours: settings.intervalHours, url }, null, 2)}\n`);
  } else {
    process.stdout.write(`ledger     ${usageLedgerPath(config.home)}\n`);
    process.stdout.write(`install    ${ledger.installId}\n`);
    process.stdout.write(`pending    ${format(ledger.pending.input)} input / ${format(ledger.pending.output)} output · ${format(ledger.pending.runs)} runs\n`);
    process.stdout.write(`reported   ${format(ledger.reported.input)} input / ${format(ledger.reported.output)} output · ${format(ledger.reported.runs)} runs\n`);
    process.stdout.write(`last try   ${stamp(ledger.lastAttemptAt)}  success ${stamp(ledger.lastSuccessAt)}  failures ${ledger.failures}\n`);
    process.stdout.write(`endpoint   ${url}  (${settings.enabled ? `on, every ${Math.round(settings.intervalHours * 60)} min` : "off"})\n`);
  }

  if (!options.push) return 0;
  if (!settings.enabled) {
    process.stderr.write("reporting is off; enable usage_stats in ~/.luban/config.json or unset LUBAN_USAGE_STATS\n");
    return 1;
  }
  let failure = "";
  const result = await flushUsageStats({
    home: config.home,
    settings,
    force: true,
    onError: (error) => { failure = error instanceof Error ? error.message : String(error); },
  });
  const after = readUsageLedger(config.home);
  if (result === "sent") {
    process.stdout.write(`pushed     ${format(after.reported.input)} input / ${format(after.reported.output)} output · ${format(after.reported.runs)} runs (pending now empty)\n`);
    return 0;
  }
  if (result === "skipped") {
    process.stdout.write("nothing pending; nothing to push\n");
    return 0;
  }
  process.stderr.write(`push failed: ${failure || "unknown error"}\n`);
  process.stderr.write(`kept ${format(after.pending.input)} input / ${format(after.pending.output)} output in the ledger; the next attempt runs on the normal schedule\n`);
  return 1;
}
