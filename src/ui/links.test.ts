import { describe, expect, it } from "vitest";
import { displayWidth } from "./input-layout.js";
import { clickTarget, externalOpenTarget, findUrlAt, openExternal, trimUrl } from "./links.js";

describe("output links", () => {
  it("finds the address under a cell, counting wide characters as two cells", () => {
    const line = "文档：https://example.com/docs 已更新";
    const start = displayWidth("文档：");
    expect(findUrlAt(line, start)).toBe("https://example.com/docs");
    expect(findUrlAt(line, start + 8)).toBe("https://example.com/docs");
    // The space right after the address is no longer part of it.
    expect(findUrlAt(line, start + "https://example.com/docs".length)).toBeNull();
    expect(findUrlAt(line, 0)).toBeNull();
  });

  it("keeps the punctuation of the sentence out of the address", () => {
    expect(trimUrl("https://example.com/a.")).toBe("https://example.com/a");
    expect(trimUrl("https://example.com/a),")).toBe("https://example.com/a");
    expect(trimUrl("https://en.wikipedia.org/wiki/Foo_(bar)")).toBe("https://en.wikipedia.org/wiki/Foo_(bar)");
    expect(trimUrl("https://example.com/a)")).toBe("https://example.com/a");
  });

  it("returns null between two addresses and past the end of the row", () => {
    const line = "a http://one.test b https://two.test";
    expect(findUrlAt(line, 2)).toBe("http://one.test");
    const second = displayWidth("a http://one.test b ");
    expect(findUrlAt(line, second)).toBe("https://two.test");
    expect(findUrlAt(line, line.length + 4)).toBeNull();
    expect(findUrlAt("", 0)).toBeNull();
  });

  it("picks the platform opener for http(s) only", () => {
    expect(externalOpenTarget("https://example.com/x?a=1&b=2", "win32")).toEqual({
      command: "rundll32", args: ["url.dll,FileProtocolHandler", "https://example.com/x?a=1&b=2"],
    });
    expect(externalOpenTarget("http://example.com", "darwin")).toEqual({ command: "open", args: ["http://example.com/"] });
    expect(externalOpenTarget("http://example.com", "linux")).toEqual({ command: "xdg-open", args: ["http://example.com/"] });
    // A click must never launch a local handler or a script scheme.
    expect(externalOpenTarget("file:///etc/passwd")).toBeNull();
    expect(externalOpenTarget("javascript:alert(1)")).toBeNull();
    expect(externalOpenTarget("not a url")).toBeNull();
  });

  it("opens only when the press and the release land on the same link", () => {
    expect(clickTarget("https://a.test", "https://a.test")).toBe("https://a.test");
    // A drag that painted a selection, or a press that started elsewhere after
    // the output grew, must not launch a browser.
    expect(clickTarget("https://a.test", null)).toBeNull();
    expect(clickTarget(null, "https://a.test")).toBeNull();
    expect(clickTarget("https://a.test", "https://b.test")).toBeNull();
  });

  it("reports a failed open instead of throwing", async () => {
    await expect(openExternal("file:///etc/passwd")).resolves.toBe(false);
  });
});
