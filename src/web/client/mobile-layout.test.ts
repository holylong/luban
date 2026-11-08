import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

// Guard the responsive layout contract; pixel geometry needs a browser/device.
const source = readFileSync(new URL("./mobile.tsx", import.meta.url), "utf8");
const css = readFileSync(new URL("./mobile.css", import.meta.url), "utf8");

describe("mobile layout", () => {
  it("keeps the composer mounted but hidden outside live view", () => {
    expect(source).toContain('className="m-compose" hidden={tab !== "live"}');
    expect(css).toContain('.m-compose[hidden] { display: none; }');
    expect(source).toContain('tab === "live" ? "m-app-compose" : ""');
  });
  it("collapses advanced task controls and keeps the input hint short", () => {
    expect(source).toContain('<details className="m-compose-options">');
    expect(source).not.toContain('<details className="m-compose-options" open');
    expect(source).toContain('aria-label="任务指令"');
    expect(source).not.toContain('placeholder={continueSession ? `继续：${continueSession.title}`');
  });
  it("prevents status badges and the brand from shrinking into vertical text", () => {
    expect(css).toMatch(/\.m-chip\s*\{[^}]*flex-shrink: 0;[^}]*white-space: nowrap;/);
    expect(css).toMatch(/\.m-brand\s*\{[^}]*flex: none;/);
    expect(css).toMatch(/\.m-device-row strong\s*\{[^}]*min-width: 0;/);
  });
});
