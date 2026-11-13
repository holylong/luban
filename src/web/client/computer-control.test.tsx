import { readFileSync } from "node:fs";
import { join } from "node:path";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { ComputerButton, computerHint, computerLabel } from "./computer-control";

const render = (status: Parameters<typeof ComputerButton>[0]["status"], pending = false): string =>
  renderToStaticMarkup(<ComputerButton status={status} pending={pending} onToggle={() => undefined} />);

describe("computer toggle", () => {
  it("reads as off and pressed=false until a human opens it", () => {
    const html = render({ enabled: false, platform: "darwin", accessibility: true, screenRecording: true });
    expect(html).toContain('class="computer-toggle"');
    expect(html).not.toContain("computer-toggle on");
    expect(html).toContain('aria-pressed="false"');
    expect(html).toContain("电脑操控");
    expect(html).toContain('title="luban 可以截屏、移动鼠标、点击和打字；开启后屏幕边缘会燃起蓝光，⌘. 随时收回"');
  });

  it("shows the burning state while the agent holds the machine", () => {
    const html = render({ enabled: true, platform: "darwin", accessibility: true, screenRecording: true });
    expect(html).toContain("computer-toggle on");
    expect(html).toContain('aria-pressed="true"');
    expect(html).toContain("操控中");
    expect(computerLabel({ enabled: true, platform: "darwin" })).toBe("操控中");
    expect(computerLabel({ enabled: false, platform: "darwin" })).toBe("电脑操控");
  });

  it("marks a missing macOS permission instead of pretending control works", () => {
    const html = render({ enabled: false, platform: "darwin", accessibility: true, screenRecording: false });
    expect(html).toContain("blocked");
    const hint = computerHint({ enabled: false, platform: "darwin", accessibility: true, screenRecording: false });
    expect(hint).toContain("屏幕录制");
    expect(hint).toContain("系统设置");
    expect(computerHint({ enabled: false, platform: "darwin", accessibility: false, screenRecording: false }))
      .toContain("辅助功能（发送点击与键盘）、屏幕录制（截屏）");
    expect(computerHint({ enabled: false, platform: "darwin", error: "找不到 computer.swift" })).toBe("找不到 computer.swift");
  });

  it("treats a denied post-event grant as missing 辅助功能", () => {
    const html = render({ enabled: false, platform: "darwin", accessibility: true, postEvent: false, screenRecording: true });
    expect(html).toContain("blocked");
    expect(computerHint({ enabled: false, platform: "darwin", accessibility: true, postEvent: false, screenRecording: true }))
      .toContain("辅助功能（发送点击与键盘）");
  });

  it("paints the live pill with the rim's own blue", () => {
    const css = readFileSync(join(process.cwd(), "src/web/client/styles.css"), "utf8");
    expect(css).toContain(".computer-toggle.on .dot { background: #6ea8ff;");
    expect(css).toMatch(/@media \(prefers-reduced-motion: reduce\) \{ \.computer-toggle\.on \.dot \{ animation: none; \} \}/u);
  });
});
