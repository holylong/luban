import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { ConciseToggle, toggleConcise } from "./app";
import type { WorkbenchStore } from "./store";

const fake = (concise: boolean) => {
  const setConcise = vi.fn(async () => undefined);
  const store = { concise, setConcise } as unknown as WorkbenchStore;
  return { store, setConcise };
};

const render = (concise: boolean): string => renderToStaticMarkup(<ConciseToggle store={fake(concise).store} />);

describe("极简模式 button", () => {
  it("reads as off and stays a pill the top bar can lay out", () => {
    const html = render(false);
    expect(html).toContain("pill toggle concise-toggle");
    expect(html).not.toContain("pill toggle concise-toggle on");
    expect(html).toContain("极简 · 关");
    expect(html).toContain("隐藏工具调用与过程说明");
  });

  it("shows the mode as on once the node reports it", () => {
    const html = render(true);
    expect(html).toContain("pill toggle concise-toggle on");
    expect(html).toContain("极简 · 开");
    expect(html).toContain("等同 /concise off");
  });

  it("writes the opposite value, since the button toggles rather than sets", async () => {
    const on = fake(true);
    await toggleConcise(on.store);
    expect(on.setConcise).toHaveBeenCalledWith(false);
    const off = fake(false);
    await toggleConcise(off.store);
    expect(off.setConcise).toHaveBeenCalledWith(true);
  });
});
