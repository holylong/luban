import React from "react";
import { renderToString } from "ink";
import { describe, expect, it } from "vitest";
import { codeTokens } from "./syntax.js";
import { DiffLine, ExecutionTimeline, executionRows, type ExecutionEntry } from "./execution-view.js";

export const sampleEntries: ExecutionEntry[] = [
  { name: "bash", detail: "npm run typecheck", status: "done", elapsedMs: 1420, preview: "TypeScript check passed" },
  { name: "edit_file", detail: "src/profile.ts", status: "done", elapsedMs: 32,
    editPreview: 'Edited src/profile.ts (+2 -1)\n    12  export async function loadProfile(userId: string) {\n    13 -  const result = await fetch("/api/user");\n    13 +  const result = await fetchProfile(userId);\n    14 +  return result ?? null;\n    15  }' },
  { name: "bash", detail: "npm test", status: "running" },
];
describe("execution presentation", () => {
  it("distinguishes variables, functions and types without losing source characters", () => {
    const source = 'const profile: User = await fetchProfile(userId, 42); // return "raw"';
    const tokens = codeTokens(source);
    expect(tokens.map(token => token.text).join("")).toBe(source);
    for (const [text, kind] of [["const", "keyword"], ["profile", "variable"], ["User", "type"], ["fetchProfile", "function"], ["42", "number"], ['// return "raw"', "comment"]]) {
      expect(tokens).toContainEqual({ text, kind });
    }
  });
  it("keeps indentation, blank additions, and source operators in diff lines", () => {
    for (const line of ["    13 +    const x = 1;", "+", "+++counter;", "    15  }"]) {
      const output = renderToString(<DiffLine line={line} />, { columns: 80 });
      expect(output).not.toContain("undefined");
    }
    expect(renderToString(<DiffLine line="    13 +    const x = 1;" />, { columns: 80 })).toContain("+     const x = 1;");
  });
  it("renders separate tool headers, commands, results, and edits in a narrow terminal", () => {
    const output = renderToString(<ExecutionTimeline entries={sampleEntries} expanded pageSize={30} />, { columns: 68 });
    expect(output).toContain("Shell");
    expect(output).toContain("$ npm run typecheck");
    expect(output).toContain("↳ TypeScript check passed");
    expect(output).toContain("Edited");
    expect(output).toContain("fetchProfile(userId)");
    expect(output).toContain("执行中");
    expect(executionRows(sampleEntries).filter(row => row.kind === "gap")).toHaveLength(3);
  });
});

describe("execution timeline scrolling", () => {
  const many: ExecutionEntry[] = Array.from({ length: 12 }, (_, index) => ({
    name: "bash", detail: `step-${index}`, status: "done" as const, preview: `output-${index}`,
  }));

  it("shows the newest rows and reports the position when the history is longer than the page", () => {
    const output = renderToString(<ExecutionTimeline entries={many} expanded pageSize={8} offset={0} />, { columns: 80 });
    expect(output).toContain("已到最新");
    expect(output).toContain("step-11");
    expect(output).not.toContain("step-0\n");
  });

  it("reports the position and reaches the oldest rows at the top of the list", () => {
    const all = executionRows(many, true).length;
    const output = renderToString(<ExecutionTimeline entries={many} expanded pageSize={8} offset={all} />, { columns: 80 });
    expect(output).toContain("已到最早");
    expect(output).toContain("0%");
    expect(output).toContain("step-0");
  });

  it("does not move past the oldest row when the offset overshoots", () => {
    // Before clamping, an overshot offset kept climbing while the view stuck,
    // so scrolling back down needed the same number of dead notches.
    const all = executionRows(many, true).length;
    const top = renderToString(<ExecutionTimeline entries={many} expanded pageSize={8} offset={all} />, { columns: 80 });
    const overshot = renderToString(<ExecutionTimeline entries={many} expanded pageSize={8} offset={all + 500} />, { columns: 80 });
    expect(overshot).toBe(top);
  });

  it("reports a plain row count when everything already fits", () => {
    const output = renderToString(<ExecutionTimeline entries={many} expanded pageSize={500} />, { columns: 80 });
    expect(output).toContain("行");
    expect(output).not.toContain("%");
  });
});
