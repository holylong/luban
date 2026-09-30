import React from "react";
import { renderToString } from "ink";
import { stripVTControlCharacters } from "node:util";
import { describe, expect, it } from "vitest";
import { argumentMatches, commandMatches, resolveCompletion, SelectDialog } from "./app.js";

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

  it("accepts the highlighted suggestion when Enter is pressed", () => {
    // `/mod` completes to the highlighted command; an exact or unknown command
    // and a plain message are left untouched.
    expect(resolveCompletion("/mod", 0)).toBe("/models");
    expect(resolveCompletion("/mod", 1)).toBe("/mode");
    expect(resolveCompletion("/mode", 0)).toBe("/mode");
    expect(resolveCompletion("/mode agent", 0)).toBe("/mode agent");
    expect(resolveCompletion("/mode a", 0)).toBe("/mode auto");
    expect(resolveCompletion("/mode a", 1)).toBe("/mode agent");
    expect(resolveCompletion("/x", 0)).toBe("/x");
    expect(resolveCompletion("hello", 0)).toBe("hello");
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
