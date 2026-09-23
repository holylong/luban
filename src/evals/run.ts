import { runEvalSuite } from "./suite.js";

const suite = await runEvalSuite();
for (const report of suite.reports) {
  const failed = report.checks.filter((item) => !item.passed).map((item) => item.name).join(",");
  process.stdout.write(`${report.ok ? "PASS" : "FAIL"} ${report.task} steps=${report.steps} tools=${report.toolCalls} ms=${report.ms}${failed ? ` failed=[${failed}]` : ""}\n`);
}
process.stdout.write(`suite ${suite.passed ? "PASSED" : "FAILED"} in ${suite.totalMs}ms\n`);
process.exitCode = suite.passed ? 0 : 1;
