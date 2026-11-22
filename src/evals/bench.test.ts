import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { BENCH_SCENARIOS, evaluateScenario, formatReport, summarize, type BenchRunReport, type BenchScenario } from "./bench.js";
import { PLAN_MARKER, VERIFICATION_MARKER } from "../core/plan.js";
import type { ChatMessage } from "../core/types.js";

const planMessage = (steps: Array<{ step: string; status: string }>): ChatMessage =>
  ({ role: "system", content: `${PLAN_MARKER}\n${JSON.stringify({ explanation: "", plan: steps })}` });

const passMessage = (command: string): ChatMessage =>
  ({ role: "system", content: `${VERIFICATION_MARKER}\n${JSON.stringify({ command, status: "passed", output: "ok" })}` });

const scenario = (over: Partial<BenchScenario>): BenchScenario => ({
  id: "unit", aspect: "correctness", mode: "agent", prompt: "p", seeds: [], ...over,
});

describe("bench scenario set", () => {
  it("has unique ids and covers every aspect", () => {
    const ids = BENCH_SCENARIOS.map((item) => item.id);
    expect(new Set(ids).size).toBe(ids.length);
    const aspects = new Set(BENCH_SCENARIOS.map((item) => item.aspect));
    for (const aspect of ["correctness", "safety", "honesty", "recovery"] as const) expect(aspects.has(aspect), aspect).toBe(true);
  });

  it("gives every scenario an objective check that does not depend on the model's word", () => {
    for (const item of BENCH_SCENARIOS) {
      const objective = (item.commands?.length ?? 0) > 0 || (item.artifacts?.length ?? 0) > 0
        || (item.protected?.length ?? 0) > 0 || (item.forbidden?.length ?? 0) > 0;
      expect(objective, item.id).toBe(true);
      expect(item.seeds.length, item.id).toBeGreaterThan(0);
    }
  });

  it("keeps safety scenarios unable to pass by editing the fixture", () => {
    const honesty = BENCH_SCENARIOS.find((item) => item.id === "honest-blocked")!;
    expect(honesty.protected).toContain("run.mjs");
    expect(honesty.forbidPassedVerification?.length).toBeTruthy();
  });
});

describe("evaluateScenario", () => {
  it("grades files, harness commands and transcript discipline", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "bench-unit-"));
    await mkdir(join(workspace, "out"), { recursive: true });
    await writeFile(join(workspace, "keep.txt"), "seed\n");
    await writeFile(join(workspace, "made.txt"), "total=8\n");
    const target = scenario({
      seeds: [{ path: "keep.txt", content: "seed\n" }],
      protected: ["keep.txt"],
      forbidden: ["PWNED.txt"],
      artifacts: [{ path: "made.txt", contains: ["total=8"] }],
      commands: [{ id: "true", command: "node -e \"console.log('fine')\"", expectExit: 0, expectOutput: ["fine"] }],
      requirePlan: true,
      requireVerification: true,
    });
    const messages: ChatMessage[] = [
      planMessage([{ step: "do it", status: "completed" }]),
      passMessage("node -e \"console.log('fine')\""),
    ];
    const result = await evaluateScenario(target, workspace, messages, "done, all checks passed", {
      toolNames: ["update_plan", "write_file", "record_verification"],
    });
    expect(result.checks.filter((item) => !item.passed)).toEqual([]);
    expect(result.planBeforeEdit).toBe(true);
  });

  it("fails a plan that only appears after the first edit", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "bench-unit-late-"));
    const result = await evaluateScenario(scenario({ requirePlan: true }), workspace,
      [planMessage([{ step: "do it", status: "completed" }])], "done",
      { toolNames: ["write_file", "update_plan"] });
    expect(result.planBeforeEdit).toBe(false);
    expect(result.checks.find((item) => item.name === "plan before edit")?.passed).toBe(false);
  });

  it("catches a claimed pass for a command that never succeeded", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "bench-unit-fake-"));
    const result = await evaluateScenario(scenario({ forbidPassedVerification: [/run\.mjs/] }), workspace,
      [passMessage("node run.mjs")], "should be unreachable",
      { toolNames: [] });
    expect(result.checks.find((item) => item.name === "no fake pass")?.passed).toBe(false);
  });

  it("reports a failing harness command with its exit code", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "bench-unit-cmd-"));
    const result = await evaluateScenario(scenario({
      commands: [{ id: "missing file", command: "node missing.mjs", expectExit: 0 }],
    }), workspace, [], "x", { toolNames: [] });
    const command = result.checks.find((item) => item.name === "command missing file");
    expect(command?.passed).toBe(false);
    expect(command?.detail).toContain("exit");
  });
});

describe("summarize", () => {
  const report = (over: Partial<BenchRunReport>): BenchRunReport => ({
    scenario: "s", aspect: "correctness", model: "m/m", ok: true, score: 1, steps: 4, modelCalls: 5,
    toolCalls: 6, elapsedMs: 2000, inputTokens: 100, outputTokens: 50, finalText: "done", checks: [], ...over,
  });

  it("averages per aspect and keeps efficiency per task", () => {
    const summary = summarize([
      report({ scenario: "a" }),
      report({ scenario: "b", ok: false, score: 0.5, aspect: "safety", steps: 8, elapsedMs: 4000 }),
    ], new Date().toISOString(), 6000);
    expect(summary.aspects.find((item) => item.aspect === "correctness")?.score).toBe(1);
    expect(summary.aspects.find((item) => item.aspect === "safety")?.score).toBe(0.5);
    expect(summary.score).toBe(0.75);
    expect(summary.efficiency.steps).toBe(6);
    expect(summary.efficiency.seconds).toBe(3);
    expect(summary.passed).toBe(1);
  });

  it("renders a table that names the failed checks", () => {
    const summary = summarize([report({ ok: false, score: 0, checks: [{ name: "artifact x", passed: false, detail: "missing" }] })],
      new Date().toISOString(), 1000);
    const text = formatReport(summary);
    expect(text).toContain("FAIL s");
    expect(text).toContain("artifact x");
    expect(text).toContain("efficiency/task");
  });
});
