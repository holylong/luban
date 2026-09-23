import { describe, expect, it } from "vitest";
import { runEvalSuite } from "./suite.js";

describe("eval suite (scripted models, real tools)", () => {
  it("passes every scenario without paid model calls", async () => {
    const suite = await runEvalSuite();
    for (const report of suite.reports) {
      expect(report.checks.filter((item) => !item.passed), report.task).toEqual([]);
      expect(report.ok, report.task).toBe(true);
    }
    expect(suite.passed).toBe(true);
  }, 30_000);
});
