import { readFileSync } from "node:fs";
import { afterEach, describe, expect, it } from "vitest";
import { hasNativeMenu, openNativeMenu, reportNativeConnected, reportNativeStatus } from "./mobile-native";

const java = readFileSync(new URL("../../../apps/android-app/app/src/main/java/dev/luban/remote/MainActivity.java", import.meta.url), "utf8");
const page = readFileSync(new URL("./mobile.tsx", import.meta.url), "utf8");
const history = readFileSync(new URL("./mobile-session.tsx", import.meta.url), "utf8");

afterEach(() => { delete (globalThis as { lubanShell?: unknown }).lubanShell; });

describe("native status bridge", () => {
  it("does nothing in a plain browser", () => {
    expect(() => reportNativeStatus({ working: false })).not.toThrow();
  });

  it("hands the working state and elapsed seconds to the shell", () => {
    const seen: string[] = [];
    (globalThis as { lubanShell?: unknown }).lubanShell = { setTaskStatus: (payload: string) => seen.push(payload) };
    reportNativeStatus({ working: true, label: "执行工具", detail: "Shell · npm test", seconds: 12, stalled: false });
    reportNativeStatus({ working: false });
    expect(seen.map(payload => JSON.parse(payload))).toEqual([
      { working: true, label: "执行工具", detail: "Shell · npm test", seconds: 12, stalled: false },
      { working: false },
    ]);
  });

  it("survives a destroyed or hostile bridge", () => {
    (globalThis as { lubanShell?: unknown }).lubanShell = { setTaskStatus: () => { throw new Error("gone"); } };
    expect(() => reportNativeStatus({ working: true, label: "生成回复" })).not.toThrow();
    (globalThis as { lubanShell?: unknown }).lubanShell = { setTaskStatus: 42 };
    expect(() => reportNativeStatus({ working: true, label: "生成回复" })).not.toThrow();
  });

  it("keeps the object and method names the JavaScript interface exposes", () => {
    expect(java).toContain('addJavascriptInterface(new TaskBridge(), "lubanShell")');
    expect(java).toMatch(/@JavascriptInterface\s+public void setTaskStatus\(String payload\)/);
    // No permanent strip: the shell reserves no height for connection state.
    expect(java).not.toContain("column.addView(bar");
    expect(java).not.toContain('bar.addView(statusDot)');
    expect(java).toContain("boolean problem = !consoleConnected;");
    expect(java).toContain("statusPill.setVisibility(problem ? View.VISIBLE : View.GONE);");
    // The floating ⋮ and the page's 设置 row open the same native menu.
    expect(java).toContain('menuButton = iconAction("⋮"');
    expect(java).toMatch(/@JavascriptInterface\s+public void openMenu\(\)/);
    expect(java).toContain('"● 已连接 · " + host');
    // A navigation invalidates old progress instead of showing it for ever.
    expect(java.indexOf('taskText = "";\n                consoleConnected = false;\n                setStatus("连接中')).toBeGreaterThan(0);
  });
});

describe("native connection state", () => {
  it("does nothing in a plain browser", () => {
    expect(() => reportNativeConnected(true)).not.toThrow();
  });

  it("clears the shell notice once the page has a node", () => {
    const seen: boolean[] = [];
    (globalThis as { lubanShell?: unknown }).lubanShell = { setConnected: (value: boolean) => seen.push(value) };
    reportNativeConnected(true);
    reportNativeConnected(false);
    expect(seen).toEqual([true, false]);
  });

  it("keeps the shell interface names in sync", () => {
    expect(java).toMatch(/@JavascriptInterface\s+public void setConnected\(boolean connected\)/);
    expect(page).toContain("reportNativeConnected(nativeConnected)");
    expect(page).toContain('const nativeConnected = ready && Boolean(node);');
  });
});

describe("native menu", () => {
  it("stays hidden in a plain browser", () => {
    expect(hasNativeMenu()).toBe(false);
    expect(() => openNativeMenu()).not.toThrow();
  });

  it("calls the shell without letting a dead bridge break the page", () => {
    let calls = 0;
    (globalThis as { lubanShell?: unknown }).lubanShell = { openMenu: () => { calls += 1; } };
    expect(hasNativeMenu()).toBe(true);
    openNativeMenu();
    expect(calls).toBe(1);
    (globalThis as { lubanShell?: unknown }).lubanShell = { openMenu: () => { throw new Error("gone"); } };
    expect(() => openNativeMenu()).not.toThrow();
    (globalThis as { lubanShell?: unknown }).lubanShell = { setTaskStatus: () => {} };
    expect(hasNativeMenu()).toBe(false);
  });

  it("puts the menu entry in 设置 instead of a bar on the page", () => {
    expect(page).toContain("{nativeShell && (");
    expect(page).toContain("openNativeMenu()");
    expect(page).not.toContain("m-head-gear");
  });
});

describe("docked phone progress", () => {
  it("sits between the transcript and the composer, not inside the session", () => {
    const dock = page.indexOf('<div className="m-live-dock"');
    expect(dock).toBeGreaterThan(page.indexOf("</main>"));
    expect(dock).toBeLessThan(page.indexOf('<div className="m-compose"'));
    expect(history).not.toContain("m-live");
  });

  it("reports both a job's stream and a live TUI session", () => {
    expect(page).toContain("sessionDetail?.live?.running");
    expect(page).toContain("if (sessionLive) return liveProgress(sessionLive.events, clock)");
    expect(page).toContain("reportNativeStatus(liveLabel");
  });

  it("follows the tail unless the reader scrolled up", () => {
    expect(page).toContain("followTranscript(scroller, content)");
    expect(page).toContain('<main className="m-main" ref={setScroller}>');
    expect(page).toContain('<div className="m-main-inner" ref={setContent}>');
  });

  it("lands on the newest line when a session or job opens", () => {
    expect(page).toContain("follower.current?.pin()");
    expect(page).toContain("useEffect(() => { pinToBottom(); }, [job?.id, continueSession?.id, pinToBottom]);");
  });
});
