import { describe, expect, it } from "vitest";
import { canonicalCommand, unknownCommandMessage } from "./app.js";

describe("canonicalCommand", () => {
  it("lowercases only the command token", () => {
    expect(canonicalCommand("/EXPORT")).toBe("/export");
    expect(canonicalCommand("/Help")).toBe("/help");
    // The argument is the user's own text and keeps its casing.
    expect(canonicalCommand("/queue Fix The Bug")).toBe("/queue Fix The Bug");
    expect(canonicalCommand("/ping MyPeer")).toBe("/ping MyPeer");
  });

  it("leaves ordinary text alone", () => {
    expect(canonicalCommand("Fix The Bug")).toBe("Fix The Bug");
    expect(canonicalCommand("Explain src/core")).toBe("Explain src/core");
    expect(canonicalCommand("")).toBe("");
  });
});

describe("unknownCommandMessage", () => {
  it("names a real command as unknown only when it is genuinely unknown", () => {
    // A mistyped case is still a real command, so the dispatcher owns it.
    for (const command of ["/export", "/help", "/queue", "/EXPORT", "/Help", "/New", "/models"]) {
      expect(unknownCommandMessage(command, ""), command).toBe("");
    }
  });

  it("points at the command the user most likely meant", () => {
    expect(unknownCommandMessage("/statuss", "")).toContain("/status");
    expect(unknownCommandMessage("/queu", "")).toContain("/queue");
    expect(unknownCommandMessage("/permisions", "")).toContain("/permissions");
    expect(unknownCommandMessage("/syncc", "")).toContain("/sync");
  });

  it("falls back to the command list when nothing looks close", () => {
    for (const command of ["/xyzzy", "/foo", "/qqqq", "/x"]) {
      expect(unknownCommandMessage(command, ""), command).toBe(`未知指令 ${command} · 输入 /help 查看全部命令`);
    }
  });

  it("keeps the argument the user typed in the message", () => {
    expect(unknownCommandMessage("/foo", "bar baz")).toBe("未知指令 /foo bar baz · 输入 /help 查看全部命令");
  });
});