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
});
