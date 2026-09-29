import { describe, expect, it } from "vitest";
import { recoverTextToolCalls } from "./tool-call-text.js";

describe("recoverTextToolCalls", () => {
  it("turns DeepSeek XML-style markup into a real bash call", () => {
    const content = [
      "<｜｜DSML｜｜ calls>",
      '<｜｜DSML｜｜ invoke name="bash">',
      '<｜｜DSML｜｜ parameter name="command" string="true">cd luban && grep -n "sharedHistory" src/core/session-history.ts</｜｜DSML｜｜ parameter>',
      "</｜｜DSML｜｜ invoke>",
      "</｜｜DSML｜｜ calls>",
    ].join("\n");
    const result = recoverTextToolCalls(content);
    expect(result.content).toBe("");
    expect(result.toolCalls).toHaveLength(1);
    expect(result.toolCalls[0]?.function.name).toBe("bash");
    expect(JSON.parse(result.toolCalls[0]!.function.arguments)).toEqual({
      command: 'cd luban && grep -n "sharedHistory" src/core/session-history.ts',
    });
  });

  it("keeps the prose before the markup and preserves multi-line string parameters", () => {
    const content = [
      "README 里有两个文件路径写错了,修正:",
      "",
      "<｜｜DSML｜｜ calls>",
      '<｜｜DSML｜｜ invoke name="edit_file">',
      '<｜｜DSML｜｜ parameter name="new_text" string="true">line one',
      "line two</｜｜DSML｜｜ parameter>",
      '<｜｜DSML｜｜ parameter name="path" string="true">neon-survivor/README.md</｜｜DSML｜ parameter>',
      "</｜｜DSML｜｜ invoke>",
      "</｜｜DSML｜｜ calls>",
    ].join("\n");
    const result = recoverTextToolCalls(content);
    expect(result.content).toBe("README 里有两个文件路径写错了,修正:");
    expect(result.toolCalls).toHaveLength(1);
    expect(JSON.parse(result.toolCalls[0]!.function.arguments)).toEqual({
      new_text: "line one\nline two",
      path: "neon-survivor/README.md",
    });
  });

  it("parses non-string parameters as JSON and recovers several calls in one block", () => {
    const content = [
      "<｜｜DSML｜｜ calls>",
      '<｜｜DSML｜｜ invoke name="edit_file">',
      '<｜｜DSML｜｜ parameter name="path" string="true">a.ts</｜｜DSML｜ parameter>',
      '<｜｜DSML｜｜ parameter name="count" string="false">3</｜ parameter>',
      "</｜｜DSML｜｜ invoke>",
      '<｜｜DSML｜｜ invoke name="bash">',
      '<｜｜DSML｜｜ parameter name="command" string="true">ls</｜｜DSML｜｜ parameter>',
      "</｜｜DSML｜｜ invoke>",
      "</｜｜DSML｜｜ calls>",
    ].join("\n");
    const result = recoverTextToolCalls(content);
    expect(result.toolCalls.map((call) => call.function.name)).toEqual(["edit_file", "bash"]);
    expect(JSON.parse(result.toolCalls[0]!.function.arguments)).toEqual({ path: "a.ts", count: 3 });
  });

  it("leaves ordinary answers untouched", () => {
    const content = "正常回答，没有工具调用。";
    expect(recoverTextToolCalls(content)).toEqual({ content, toolCalls: [] });
  });

  it("leaves a block without a parseable invoke untouched", () => {
    const content = "<｜｜DSML｜｜ calls>\n<｜｜DSML｜｜ invoke>\n</｜｜DSML｜｜ calls>";
    expect(recoverTextToolCalls(content)).toEqual({ content, toolCalls: [] });
  });
});
