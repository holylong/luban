import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

/**
 * Two complaints from the window itself: 「后台」 read as a hidden process, so
 * nobody knew the list was their own task history; and every surface was the
 * same flat white, so the composer, a task row and the drawer all sat at one
 * height. These cases pin the words and the depth, not a pixel snapshot.
 */
const css = readFileSync(new URL("./creator.css", import.meta.url), "utf8");
const source = readFileSync(new URL("./creator.tsx", import.meta.url), "utf8");

const body = (selector: string): string => {
  const pattern = new RegExp(`(?:^|\\n)${selector.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&")}\\s*\\{([^}]*)\\}`, "u");
  const found = pattern.exec(css);
  if (!found) throw new Error(`no rule for ${selector}`);
  return found[1]!;
};

describe("Creator wording", () => {
  it("calls the queue 任务记录, never a bare 后台", () => {
    // Visible strings only: comments may still explain why the word was dropped.
    const visible = source.split("\n").filter(line => !/^\s*(\*|\/\/|\/\*)/u.test(line)).join("\n");
    expect(visible).not.toMatch(/后台（/u);
    expect(visible).not.toContain("后台任务");
    expect(visible).toContain("任务记录");
    expect(visible).toContain("最近任务（");
  });

  it("labels the finished list 已完成 and names the runner plainly", () => {
    expect(source).toContain('["done", "已完成"]');
    expect(source).not.toContain('"结果"');
    expect(source).toContain("执行器正在执行");
    expect(source).toContain("执行器未启动");
  });

  it("keeps stable data-view hooks so rewording cannot break the smoke run", () => {
    for (const view of ["drive", "queue", "plans", "policy", "memory"]) {
      expect(source).toContain(`data-view="${view}"`);
    }
  });
});

describe("Creator depth", () => {
  it("defines one elevation scale instead of ad-hoc shadows", () => {
    const root = body(":root");
    for (const token of ["--lift-1", "--lift-2", "--lift-3", "--bevel", "--card-fill"]) {
      expect(root).toContain(token);
    }
    // Three lifts must be strictly ordered, or "higher" stops meaning anything.
    // A blurrier shadow reads as further off the page, so compare the largest
    // blur radius each token uses.
    const blur = (name: string): number => {
      const found = new RegExp(`${name}:\\s*([^;]*);`, "u").exec(root);
      if (!found) throw new Error(`no value for ${name}`);
      const radii = [...found[1]!.matchAll(/(\d+)px/gu)].map(match => Number(match[1]));
      return Math.max(...radii);
    };
    expect(blur("--lift-1")).toBeLessThan(blur("--lift-2"));
    expect(blur("--lift-2")).toBeLessThan(blur("--lift-3"));
    expect(root).toContain("--bevel");
  });

  it("raises the surfaces a person acts on, and the drawer above all of them", () => {
    expect(body(".composer")).toContain("var(--lift-3)");
    for (const surface of [".task", ".suggest button", ".quick button", ".round", ".worker", ".plan", ".memory-project"]) {
      expect(body(surface)).toContain("var(--lift-");
    }
    expect(body(".drawer")).toContain("-28px 0 64px");
    // A shadow on a resting control must not be a hover-only affordance.
    expect(body(".side")).toContain("inset -1px 0 0");
    expect(body(".you span")).toContain("linear-gradient");
  });

  it("lifts the 操控 composer above the log it scrolls under", () => {
    // The default view's input is a bare textarea on a canvas: without a shadow
    // and a dock it is indistinguishable from the page.
    expect(body(".drive-composer")).toContain("0 -12px 26px");
    expect(body(".drive-composer textarea")).toContain("var(--lift-2)");
    expect(body(".drive-composer textarea:focus")).toContain("var(--lift-3)");
  });
});
