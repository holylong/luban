import { describe, expect, it } from "vitest";
import { DASHBOARD_HTML, DOCS_HTML } from "./assets.js";

describe("web assets", () => {
  it("ships a self-contained dashboard with syntactically valid client JavaScript", () => {
    expect(DASHBOARD_HTML).toContain("Agent Workspace");
    expect(DASHBOARD_HTML).not.toMatch(/https?:\/\/[^\s]+\.(?:js|css)/u);
    const script = /<script>([\s\S]*)<\/script>/u.exec(DASHBOARD_HTML)?.[1];
    expect(script).toBeTruthy();
    expect(() => new Function(script!)).not.toThrow();
  });

  it("documents the native API without referring to a Python dependency", () => {
    expect(DOCS_HTML).toContain("/api/jobs");
    expect(DOCS_HTML).toContain("不依赖 Python 后台");
  });
});
