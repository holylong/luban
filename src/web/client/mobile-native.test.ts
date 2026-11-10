import { readFileSync } from "node:fs";
import { afterEach, describe, expect, it } from "vitest";
import { reportNativeStatus } from "./mobile-native";

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
    // The native strip replaces the connection line while work is running.
    expect(java).toContain("boolean busy = !taskText.isEmpty();");
    expect(java).toContain("status.setText(busy ? taskText : connectionText);");
    // A navigation invalidates old progress instead of showing it for ever.
    expect(java.indexOf('taskText = "";\n                setStatus("连接中')).toBeGreaterThan(0);
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
    expect(page).toContain('followTranscript(element, content)');
    expect(page).toContain("pinToBottom()");
    expect(page).toContain('<div className="m-main-inner" ref={contentRef}>');
  });
});
