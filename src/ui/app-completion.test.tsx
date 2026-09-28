import React from "react";
import { renderToString } from "ink";
import { stripVTControlCharacters } from "node:util";
import { describe, expect, it } from "vitest";
import { argumentMatches, commandMatches, SelectDialog } from "./app.js";

describe("slash command suggestions", () => {
  it("keeps all matching commands available and puts prefix matches first", () => {
    expect(commandMatches("/s").map(([name]) => name)).toEqual(expect.arrayContaining(["/sessions", "/settings", "/status", "/sync"]));
    expect(commandMatches("/ses")[0]?.[0]).toBe("/sessions");
    expect(commandMatches("/x")).toEqual([]);
    expect(commandMatches("hello")).toEqual([]);
  });

  it("suggests values for commands with a fixed first argument", () => {
    expect(argumentMatches("/mode a")).toEqual(["auto", "agent", "ask"]);
    expect(argumentMatches("/permissions e")).toEqual(["edits"]);
    expect(argumentMatches("/THEME nord")).toEqual(["nord"]);
    expect(argumentMatches("/sync p")).toEqual(["push", "pull"]);
    expect(argumentMatches("/sessions ")).toEqual([]);
  });
});

it("keeps the selected session visible and colors its metadata", () => {
  const rows = Array.from({ length: 20 }, (_, index) => ({
    key: `s${index}`, title: `Session ${index}`, detail: "project · date",
    project: "project", date: "2026-09-28 09:00", turns: index,
  }));
  const output = renderToString(<SelectDialog title="Sessions" rows={rows} index={15} activeKey="s15" />, { columns: 120 });
  const plain = stripVTControlCharacters(output);
  expect(plain).toContain("Session 15 ●当前");
  expect(plain).not.toContain("Session 0 ");
  expect(plain).toContain("15轮");
});
