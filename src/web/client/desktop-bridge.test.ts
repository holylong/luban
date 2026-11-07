import { describe, expect, it } from "vitest";
import { acceptSaved, desktopErrorText, quickMatches } from "./desktop-bridge";

describe("desktop error text", () => {
  it("unwraps the IPC channel and explains a refusal", () => {
    expect(desktopErrorText(new Error("Error invoking remote method 'luban:readFile': Error: File exceeds 4 MB limit"), "assets/big.bin"))
      .toBe("assets/big.bin 超过 4 MB，桌面编辑器不加载这么大的文件；请在终端或用其他编辑器查看。");
    expect(desktopErrorText("Error invoking remote method 'luban:readFile': Error: Binary files are not supported", "clip.mp4"))
      .toBe("clip.mp4 是二进制内容（图片、压缩包或可执行文件），代码编辑器无法打开。");
    expect(desktopErrorText("Error invoking remote method 'luban:readFile': Error: File is UTF-16 encoded, save it as UTF-8 first", "a.txt"))
      .toContain("UTF-16");
    expect(desktopErrorText("Error invoking remote method 'luban:readFile': Error: ENOENT: no such file or directory", "gone.ts"))
      .toContain("已不存在");
  });
  it("keeps an unknown reason readable", () => {
    expect(desktopErrorText(new Error("Error invoking remote method 'luban:saveFile': Error: Invalid save request"))).toBe("Invalid save request");
    expect(desktopErrorText(undefined)).toBe("未知错误");
  });
});

describe("desktop editor state", () => {
  it("keeps typing made while a save was in flight dirty", () => {
    const result = acceptSaved({ path: "a.ts", content: "newer typing", saved: "original", revision: "old" }, { path: "a.ts", content: "saved snapshot", revision: "new" });
    expect(result.content).toBe("newer typing");
    expect(result.saved).toBe("saved snapshot");
    expect(result.revision).toBe("new");
    expect(result.content).not.toBe(result.saved);
  });
  it("marks an unchanged saved snapshot clean", () => {
    const result = acceptSaved({ path: "a.ts", content: "saved", saved: "original", revision: "old" }, { path: "a.ts", content: "saved", revision: "new" });
    expect(result.content).toBe(result.saved);
  });
  it("matches paths by all case-insensitive query terms", () => {
    expect(quickMatches(["src/App.tsx", "src/app.test.ts", "docs/app.md"], " SRC app.TSX ")).toEqual(["src/App.tsx"]);
    expect(quickMatches(["a", "b"], "missing")).toEqual([]);
  });
  it("bounds quick open results", () => {
    expect(quickMatches(Array.from({ length: 200 }, (_, index) => `file-${index}`), "")).toHaveLength(100);
  });
});
