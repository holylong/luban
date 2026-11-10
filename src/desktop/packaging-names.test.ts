import { describe, expect, it } from "vitest";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

const root = join(__dirname, "..", "..");
const read = (path: string) => readFileSync(join(root, path), "utf8");

describe("desktop packaging names", () => {
  it("installs the app as luban, without the Desktop suffix", () => {
    expect(read("scripts/package-macos.mjs")).toContain('const APP_NAME = "luban";');
    expect(read("apps/desktop/main.cjs")).toContain('app.setName("luban");');
    expect(read("apps/desktop/main.cjs")).toContain("return `luban${");
    expect(read("packaging/linux/luban.desktop")).toContain("Name=luban\n");
    expect(read("scripts/package-windows.mjs")).toContain('ProductName: "luban"');
    expect(read("packaging/macos/luban-desktop")).toContain('"$root/luban.app/Contents/Resources"');
  });

  it("ships a rounded macOS icon and keeps the square one for the tray", () => {
    expect(existsSync(join(root, "assets", "luban-app-1024.png"))).toBe(true);
    expect(existsSync(join(root, "assets", "luban-512.png"))).toBe(true);
    // The macOS iconset must come from the rounded asset, or Finder shows a square.
    expect(read("scripts/package-macos.mjs")).toContain('"luban-app-1024.png"');
  });
});
