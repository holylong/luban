import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

// Guard the responsive layout contract; pixel geometry needs a browser/device.
const source = readFileSync(new URL("./mobile.tsx", import.meta.url), "utf8");
const css = readFileSync(new URL("./mobile.css", import.meta.url), "utf8");

/** The composer element, isolated so "no controls in here" can be asserted. */
const composer = source.slice(source.indexOf('className="m-compose"'), source.indexOf('<nav className="m-tabs">'));
/** The settings tab, isolated so the controls can be found where they moved. */
const settings = source.slice(source.indexOf('{tab === "settings" && ('), source.indexOf('<nav className="m-tabs">'));

describe("mobile layout", () => {
  it("keeps the composer mounted but hidden outside live view", () => {
    expect(source).toContain('className="m-compose" hidden={tab !== "live"}');
    expect(css).toContain('.m-compose[hidden] { display: none; }');
    expect(source).toContain('tab === "live" ? "m-app-compose" : ""');
  });

  it("spends one line on the header instead of a status block", () => {
    expect(source).toContain('className="m-head-bar"');
    expect(source).not.toContain("m-head-meta");
    expect(source).not.toContain("m-head-context");
    expect(source).not.toContain("m-head select");
    const header = source.slice(source.indexOf("<header"), source.indexOf("</header>"));
    expect(header).not.toContain("<select");
  });

  it("keeps task controls out of the composer", () => {
    expect(composer).toContain('aria-label="任务指令"');
    expect(composer).not.toContain("<select");
    expect(composer).not.toContain('<details className="m-compose-options">');
    expect(composer).toContain('className="m-compose-summary"');
    expect(composer).toContain('setTab("settings")');
  });

  it("collects session, project and permission choices under 设置", () => {
    for (const label of ['aria-label="继续会话"', 'aria-label="项目"', 'aria-label="权限"']) {
      expect(settings).toContain(label);
    }
    expect(settings).toContain("addWorkspace(\"new\")");
    expect(settings).toContain("addWorkspace(\"existing\")");
    expect(settings).toContain("<h3>派活</h3>");
  });

  it("keeps the continue-session banner on one row with a visible button", () => {
    expect(source).toContain('className="m-banner m-session-bar"');
    expect(source).toContain('className="m-session-new"');
    expect(source).not.toContain("将接续会话：");
    expect(css).toMatch(/\.m-session-bar \{ display: flex;/);
    expect(css).toContain(".m-session-new {");
    expect(css).toContain("background: var(--primary-bg);");
  });

  it("shows the provider next to each model in 设置", () => {
    expect(settings).toContain("{item.provider}");
  });

  it("prevents status badges and names from shrinking into vertical text", () => {
    expect(css).toMatch(/\.m-chip\s*\{[^}]*flex-shrink: 0;[^}]*white-space: nowrap;/);
    expect(css).toMatch(/\.m-brand\s*\{[^}]*flex: none;/);
    expect(css).toMatch(/\.m-device-row strong\s*\{[^}]*min-width: 0;/);
  });
});
