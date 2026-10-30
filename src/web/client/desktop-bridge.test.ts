import { describe, expect, it } from "vitest";
import { acceptSaved, quickMatches } from "./desktop-bridge";

describe("desktop editor state", () => {
  it("keeps typing made while a save was in flight dirty", () => {
    const result = acceptSaved({ path: "a.ts", content: "newer typing", saved: "original", revision: "old" }, { path: "a.ts", content: "saved snapshot", revision: "new" });
    expect(result.content).toBe("newer typing");
    expect(result.saved).toBe("saved snapshot");
    expect(result.revision).toBe("new");
    expect(result.content).not.toBe(result.saved);
  });
  it("marks an unchanged saved snapshot clean", () => {
    const result = acceptSaved({ path: "a.ts", content: "saved", saved: "original", revision: "old" }, { path: "a.ts", content: "saved", revision: "new" });
    expect(result.content).toBe(result.saved);
  });
  it("matches paths by all case-insensitive query terms", () => {
    expect(quickMatches(["src/App.tsx", "src/app.test.ts", "docs/app.md"], " SRC app.TSX ")).toEqual(["src/App.tsx"]);
    expect(quickMatches(["a", "b"], "missing")).toEqual([]);
  });
  it("bounds quick open results", () => {
    expect(quickMatches(Array.from({ length: 200 }, (_, index) => `file-${index}`), "")).toHaveLength(100);
  });
});
