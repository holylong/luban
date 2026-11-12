import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { Transcript } from "./transcript";
import type { MeshJob, TimelineItem } from "./types";

// Guard the agent column's layout contract. Pixel geometry needs a browser, but
// the two things the column got wrong are visible in the source: an avatar that
// owned a 36px column of its own, and tables squeezed instead of scrolled.
const transcript = readFileSync(new URL("./transcript.tsx", import.meta.url), "utf8");
const markdown = readFileSync(new URL("./markdown.tsx", import.meta.url), "utf8");
const css = readFileSync(new URL("./styles.css", import.meta.url), "utf8");
const desktop = readFileSync(new URL("./desktop.css", import.meta.url), "utf8");

const job = { id: "job-1", status: "done", instruction: "看看这个", events: [] } as unknown as MeshJob;

describe("agent column layout", () => {
  it("puts the avatar in the name row instead of its own left column", () => {
    const html = renderToStaticMarkup(
      <Transcript job={job} events={[{ id: "e1", kind: "user", text: "问题", at: 1 } as unknown as TimelineItem]} onCancel={() => {}} onResume={() => {}} />,
    );
    // <div class="head"><div class="avatar user">Y</div><span>你</span>…
    expect(html).toMatch(/<div class="head"><div class="avatar user">Y<\/div>/u);
    expect(transcript).not.toContain('<Avatar kind="user" />\n          <div>');
    // A grid with an empty avatar column is what left the gutter in the first place.
    expect(css).not.toMatch(/\.msg\s*\{[^}]*grid-template-columns:\s*26px/u);
    expect(css).toMatch(/\.avatar\s*\{[^}]*width:\s*20px/u);
  });

  it("keeps every block on the message's left edge", () => {
    for (const selector of [".note", ".thinking-block", ".tool", ".result", ".runbar"]) {
      const rule = new RegExp(`\\${selector}\\s*\\{[^}]*\\}`, "u").exec(css)?.[0] ?? "";
      expect(rule).not.toMatch(/margin:[^;]*\b3[0-9]px/u);
    }
    // The saved transcript used to pad itself back out, leaving one column at
    // 27px and the live messages at 15px.
    expect(desktop).toContain(".desktop-agent .session-body { padding: 0 0 16px; }");
    expect(desktop).toContain(".desktop-agent .banner { padding: 6px 0; }");
  });

  it("scrolls a table instead of collapsing its cells", () => {
    expect(markdown).toContain('<div className="md-table"');
    expect(css).toMatch(/\.md-table\s*\{[^}]*overflow-x:\s*auto/u);
    // Cells keep a readable minimum width; the table overflows the wrapper, which
    // scrolls, instead of every column collapsing to a few characters.
    expect(css).toMatch(/\.md-table th, \.md-table td\s*\{[^}]*min-width:\s*96px/u);
    expect(css).toMatch(/\.md-table table\s*\{[^}]*width:\s*100%/u);
  });
});
