/**
 * `npm run bench` — grade luban against a real model.
 *
 *   npm run bench                       # every scenario, active model
 *   npm run bench -- --model deepseek/deepseek-flash
 *   npm run bench -- --only bugfix-tested,recovery --repeat 2
 *   npm run bench -- --list             # scenario ids, no model calls
 */
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { BENCH_SCENARIOS, formatReport, runBench, writeReport, type BenchOptions } from "./bench.js";

interface Args extends BenchOptions { repeat?: number; out?: string; list?: boolean; quiet?: boolean }

function parseArgs(argv: string[]): Args {
  const args: Args = {};
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index]!;
    const value = argv[index + 1];
    const take = (): string => {
      if (!value || value.startsWith("--")) throw new Error(`${flag} needs a value`);
      index += 1;
      return value;
    };
    if (flag === "--list") args.list = true;
    else if (flag === "--quiet") args.quiet = true;
    else if (flag === "--model") args.model = take();
    else if (flag === "--only") args.only = take().split(",").map((id) => id.trim()).filter(Boolean);
    else if (flag === "--repeat") args.repeat = Math.max(1, Number(take()) || 1);
    else if (flag === "--max-steps") args.maxSteps = Math.max(1, Number(take()) || 30);
    else if (flag === "--timeout") args.timeoutMs = Math.max(10_000, Number(take()) * 1000 || 300_000);
    else if (flag === "--out") args.out = take();
    else if (flag === "--help" || flag === "-h") {
      process.stdout.write(
        "usage: npm run bench -- [--model id] [--only a,b] [--repeat n] [--max-steps n] [--timeout seconds] [--out dir] [--list]\n",
      );
      process.exit(0);
    } else throw new Error(`unknown flag: ${flag}`);
  }
  return args;
}

const args = parseArgs(process.argv.slice(2));

if (args.list) {
  for (const scenario of BENCH_SCENARIOS) {
    process.stdout.write(`${scenario.id.padEnd(20)} ${scenario.aspect.padEnd(12)} ${scenario.mode.padEnd(6)} ${scenario.prompt.slice(0, 70)}\n`);
  }
  process.exit(0);
}

const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
const outDir = args.out ?? join("bench-runs", stamp);

const summary = await runBench({
  ...args,
  onProgress: (line) => { if (!args.quiet) process.stderr.write(`${line}\n`); },
});

process.stdout.write(`\n${formatReport(summary)}`);
await mkdir(outDir, { recursive: true });
const files = await writeReport(summary, outDir);
process.stdout.write(`\nreport: ${files.markdown}\n        ${files.json}\n`);
process.exitCode = summary.passed === summary.scenarios ? 0 : 1;
