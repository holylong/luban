import { expect, it } from "vitest";
import { executionPreview } from "./execution-preview.js";

it("fits multiple edits into the viewport while keeping the latest header and changes", () => {
  const result = executionPreview([
    { name: "write_file", detail: "", editPreview: ["Edited example.ts (+32 -0)", ...Array.from({ length: 32 }, (_, i) => `${i + 1} +line`)].join("\n") },
    { name: "edit_file", detail: "", editPreview: "Edited example.ts (+1 -1)\n11 -old\n11 +new" },
  ], 10);
  expect(result).toHaveLength(10);
  expect(result[0]).toBe("Edited example.ts (+32 -0)");
  expect(result.slice(-3)).toEqual(["Edited example.ts (+1 -1)", "11 -old", "11 +new"]);
  expect(result).toContain("    … /details 查看其余改动");
});
