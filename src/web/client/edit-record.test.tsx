import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { EditRecord, SPLIT_MIN_WIDTH, editRecordLayout } from "./tool-card";

// The middle column shows one change while a run is working. A 420px agent
// column and a ~700px code column both used to get the side-by-side record:
// every line wrapped two or three times under a 340px cap, so the change read
// as ragged fragments in a box that only filled half the pane.
const preview = [
  "Edited src/web/client/tool-card.tsx (+2 -1)",
  "   12 -const split = true;",
  "   12 +const split = width >= SPLIT_MIN_WIDTH;",
  "   13 +const rows = parsed.map(row => row);",
  "   14  return row;",
].join("\n");

const styles = readFileSync(new URL("./styles.css", import.meta.url), "utf8");
const desktop = readFileSync(new URL("./desktop.css", import.meta.url), "utf8");

const rule = (css: string, selector: string): string => {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
  const pattern = new RegExp(`(?:^|\\n)${escaped}\\s*\\{([^}]*)\\}`, "u");
  const found = pattern.exec(css);
  if (!found) throw new Error(`no rule for ${selector}`);
  return found[1]!;
};

describe("edit record layout", () => {
  it("renders one aligned column until the pane is wide enough for two", () => {
    // Server render and first paint have no width: the unified column is the
    // safe default, never the cramped split.
    const html = renderToStaticMarkup(<EditRecord preview={preview} />);
    expect(html).toContain('class="edit-lines"');
    expect(html).toContain("edit-line remove");
    expect(html).toContain("edit-line add");
    expect(html).not.toContain("edit-split");
    expect(html).toContain('data-layout="unified"');
  });

  it("keeps both halves when there is room for a side-by-side record", () => {
    const html = renderToStaticMarkup(<EditRecord preview={preview} layout="split" />);
    expect(html).toContain("edit-split-row");
    expect(html).toContain("edit-cell remove left");
    expect(html).toContain("edit-cell add right");
    expect(html).not.toContain('class="edit-lines"');
  });

  it("states the file, counts and line range in either layout", () => {
    for (const layout of ["auto", "split"] as const) {
      const html = renderToStaticMarkup(<EditRecord preview={preview} layout={layout} />);
      expect(html).toContain("src/web/client/tool-card.tsx");
      expect(html).toContain("+2");
      expect(html).toContain("−1");
      expect(html).toContain("L12–14");
    }
  });

  it("switches to two columns only once both halves are readable", () => {
    expect(SPLIT_MIN_WIDTH).toBeGreaterThanOrEqual(840);
    // Unmeasured (server render, first paint) must not mean "cramped".
    expect(editRecordLayout("auto", 0)).toBe("unified");
    expect(editRecordLayout("auto", SPLIT_MIN_WIDTH - 1)).toBe("unified");
    expect(editRecordLayout("auto", SPLIT_MIN_WIDTH)).toBe("split");
    expect(editRecordLayout("split", 240)).toBe("split");
    expect(editRecordLayout("unified", 1600)).toBe("unified");
  });
});

describe("edit record density", () => {
  it("uses a diff line height instead of chat leading", () => {
    const font = /font:\s*([^;]+)/u.exec(rule(styles, ".edit-record"))?.[1] ?? "";
    const ratio = /(\d+(?:\.\d+)?)px\/(\d+(?:\.\d+)?)/u.exec(font);
    expect(ratio).not.toBeNull();
    expect(Number(ratio![2])).toBeLessThanOrEqual(1.5);
  });

  it("pins the number and sign columns so wrapped text cannot slide under them", () => {
    const line = rule(styles, ".edit-line");
    expect(line).toMatch(/grid-template-columns:\s*46px 14px 1fr/u);
    expect(rule(styles, ".edit-line .code")).toMatch(/min-width:\s*0/u);
  });

  it("keeps the file preview's chat leading out of the diff rows", () => {
    // A bare `.code` rule carried 1.6 leading plus 26px of vertical padding
    // into every diff cell: 44px rows where a line needs 17.
    expect(styles).not.toMatch(/(?:^|\n)\.code\s*\{/u);
    expect(styles).toMatch(/(?:^|\n)\.preview-code\s*\{/u);
  });

  it("lets the change fill the middle pane instead of stopping at 340px", () => {
    expect(rule(desktop, ".desktop-changes")).toMatch(/display:\s*flex/u);
    expect(rule(desktop, ".desktop-changes .edit-record")).toMatch(/flex:\s*1/u);
    const body = rule(desktop, ".desktop-changes .edit-lines, .desktop-changes .edit-split");
    expect(body).toMatch(/max-height:\s*none/u);
    expect(body).toMatch(/flex:\s*1/u);
  });
});
