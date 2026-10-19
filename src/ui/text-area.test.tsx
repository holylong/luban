import React from "react";
import { renderToString } from "ink";
import { describe, expect, it } from "vitest";
import { TextArea } from "./text-area.js";
import { offsetAtColumn } from "./input-layout.js";

describe("composer rows", () => {
  it("aligns continuation rows without adding the parent prefix a second time", () => {
    const output = renderToString(<TextArea value={"first\nsecond"} onChange={() => {}} onSubmit={() => {}} focus={false} placeholder="" width={20} maxRows={4} />, { columns: 20 });
    expect(output.split("\n")).toEqual(["first", "second"]);
  });
  it("moves vertically by terminal columns without splitting emoji", () => {
    expect(offsetAtColumn("中文abc", 4)).toBe(2);
    expect(offsetAtColumn("a😀b", 2)).toBe(1);
    expect(offsetAtColumn("a😀b", 3)).toBe(3);
    expect(offsetAtColumn("abc", 99)).toBe(3);
  });
  // A placeholder wider than the box used to soft-wrap, so an untouched draft
  // painted two or three rows while holding no text at all.
  it("keeps an empty box on one row however wide the placeholder is", () => {
    const placeholder = "补充指令 / /queue 排队 / 只读命令即时执行（/status /models…）· Esc 中断";
    for (const columns of [120, 80, 72, 60, 40]) {
      const width = Math.max(1, columns - 8);
      const output = renderToString(
        <TextArea value="" onChange={() => {}} onSubmit={() => {}} focus={false} placeholder={placeholder} width={width} maxRows={12} />,
        { columns },
      );
      expect(output.split("\n"), `columns=${columns}`).toHaveLength(1);
    }
  });
  it("keeps the placeholder caret on the same single row", () => {
    const output = renderToString(
      <TextArea value="" onChange={() => {}} onSubmit={() => {}} focus placeholder="Message luban…" width={40} maxRows={4} />,
      { columns: 40 },
    );
    expect(output.split("\n")).toHaveLength(1);
  });
});
