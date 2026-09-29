import { Command } from "commander";
import { loadConfig } from "./config.js";
import { SessionHistory, type HistoryHit, type HistorySession } from "./session-history.js";
import { VERSION } from "../version.js";

/**
 * `luban history` — read the SQLite mirror written by `history.enabled`.
 * It answers the two questions the JSON records cannot answer cheaply: which
 * sessions exist at all, and which one contains the text being looked for.
 *
 * @param argv Arguments after `luban history`.
 * @returns Process exit code.
 */
export async function runHistory(argv: string[]): Promise<number> {
  const program = new Command();
  program
    .name("luban history")
    .description("Query the SQLite mirror of saved sessions (enable with history.enabled)")
    .version(VERSION)
    .argument("[path]", "workspace directory", process.cwd())
    .option("-q, --query <text>", "search stored messages for this text")
    .option("-p, --project <name>", "limit results to one project")
    .option("-n, --limit <count>", "maximum results", (value) => Number(value), 20)
    .option("--full", "print whole messages instead of the first line")
    .showHelpAfterError();
  program.parse(argv, { from: "user" });
  const workspace = (program.args[0] ?? process.cwd()) as string;
  const options = program.opts<{ query?: string; project?: string; limit?: number; full?: boolean }>();
  const config = loadConfig({ workspace });
  const history = SessionHistory.openForRead(config.history, config.home);
  if (!history) {
    const directory = config.history.directory || `${config.home}/history`;
    process.stderr.write(config.history.enabled
      ? `no history database in ${directory} yet\n`
      : `history is off; set "history": { "enabled": true } in config.json to record it (looked in ${directory})\n`);
    return 1;
  }
  try {
    const limit = Number.isFinite(options.limit) && options.limit! > 0 ? Math.floor(options.limit!) : 20;
    if (options.query) printHits(history.search(options.query, limit), options.full === true);
    else printSessions(history.sessions(options.project, limit));
    return 0;
  } finally {
    history.close();
  }
}

/** One line per session: enough to identify it and paste into `--resume`. */
function printSessions(sessions: HistorySession[]): void {
  if (sessions.length === 0) {
    process.stdout.write("no mirrored sessions yet\n");
    return;
  }
  for (const session of sessions) {
    process.stdout.write(`${session.updatedAt}  ${session.id}  ${session.messages} msgs  [${session.project}] ${session.title}\n`);
  }
}

/** One block per hit: session, position, and the message text. */
function printHits(hits: HistoryHit[], full: boolean): void {
  if (hits.length === 0) {
    process.stdout.write("no matching messages\n");
    return;
  }
  for (const hit of hits) {
    const content = hit.message.content ?? "";
    const text = full ? content : content.split("\n")[0]!.slice(0, 200);
    process.stdout.write(`${hit.sessionId} #${hit.seq} ${hit.role} ${hit.createdAt}\n  ${text}\n`);
  }
}
