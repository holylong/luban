import { afterEach, expect, it, vi } from "vitest";
import { followTranscript } from "./transcript-scroll";
afterEach(() => vi.unstubAllGlobals());
it("follows dynamic content and viewport changes, pauses for reading, resets and cleans up", () => {
  let resize = () => {};
  const disconnect = vi.fn();
  vi.stubGlobal("ResizeObserver", class {
    constructor(callback: () => void) { resize = callback; }
    observe = vi.fn();
    disconnect = disconnect;
  });
  let top = 0;
  let height = 1000;
  const listeners = new Map<string, () => void>();
  const element = {
    clientHeight: 300,
    get scrollHeight() { return height; },
    get scrollTop() { return top; },
    set scrollTop(value: number) { top = Math.max(0, Math.min(value, height - this.clientHeight)); },
    addEventListener: (name: string, callback: () => void) => listeners.set(name, callback),
    removeEventListener: (name: string) => listeners.delete(name),
  };
  const controller = followTranscript(element as unknown as HTMLElement, {} as HTMLElement);
  expect(top).toBe(700);
  height = 1400;
  listeners.get("scroll")!(); // Content growth must not unpin the viewport.
  resize();
  expect(top).toBe(1100);
  top = 200;
  listeners.get("scroll")!();
  height = 1800;
  controller.follow();
  resize();
  expect(top).toBe(200);
  top = 1500;
  listeners.get("scroll")!();
  height = 2000;
  resize();
  expect(top).toBe(1700);
  element.clientHeight = 200;
  resize();
  expect(top).toBe(1800);
  top = 0;
  listeners.get("scroll")!();
  controller.reset();
  expect(top).toBe(1800);
  controller.dispose();
  expect(disconnect).toHaveBeenCalledOnce();
  expect(listeners.size).toBe(0);
});
