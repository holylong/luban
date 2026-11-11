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
    for (const label of ['ariaLabel="继续会话"', 'aria-label="项目"', 'aria-label="权限"']) {
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

  it("folds the long model and session lists behind their current choice", () => {
    // Two long lists used to occupy the whole 设置 page; the collapsed header
    // carries the answer, and the rows only appear when asked for.
    expect(settings).toContain('<MobileCollapse label="会话" ariaLabel="继续会话"');
    expect(settings).toContain('<MobileCollapse label="可选模型" ariaLabel="可选模型"');
    expect(settings).toContain("summary={continueSession ? `继续：${continueSession.title}` : \"新会话\"}");
    expect(settings).toContain("summary={activeModel ?");
    expect(source).not.toContain("defaultOpen");
  });

  it("keeps the composer at screen width even with a long session title", () => {
    // The composer is a grid, and an implicit `auto` track is sized by its
    // widest child's max-content: the summary line prints the session title,
    // so one long title stretched the composer to 410px on a 390px phone and
    // the send button slid off the right edge. Measured in Chrome at 390px.
    expect(css).toMatch(/\.m-compose \{[^}]*grid-template-columns: minmax\(0, 1fr\);/);
    expect(css).toMatch(/\.m-compose-box \{[^}]*max-width: 100%;/);
    expect(css).toMatch(/\.m-compose-summary \{[^}]*min-width: 0;[^}]*overflow: hidden;/);
  });

  it("wraps long titles instead of scrolling the transcript sideways", () => {
    expect(css).toMatch(/\.m-main-inner h1, \.m-main-inner h2, \.m-main-inner h3 \{[^}]*overflow-wrap: anywhere;/);
  });

  it("prevents status badges and names from shrinking into vertical text", () => {
    expect(css).toMatch(/\.m-chip\s*\{[^}]*flex-shrink: 0;[^}]*white-space: nowrap;/);
    expect(css).toMatch(/\.m-brand\s*\{[^}]*flex: none;/);
    expect(css).toMatch(/\.m-device-row strong\s*\{[^}]*min-width: 0;/);
  });
});
