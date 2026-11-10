import { afterEach, expect, it, vi } from "vitest";
import { followTranscript } from "./transcript-scroll";

afterEach(() => vi.unstubAllGlobals());

/** A scroll container whose content the test can grow or shrink. */
function harness(startHeight = 1000, clientHeight = 300) {
  let resize = () => {};
  const disconnect = vi.fn();
  vi.stubGlobal("ResizeObserver", class {
    constructor(callback: () => void) { resize = callback; }
    observe = vi.fn();
    disconnect = disconnect;
  });
  let top = 0;
  let height = startHeight;
  const listeners = new Map<string, () => void>();
  const element = {
    clientHeight,
    get scrollHeight() { return height; },
    get scrollTop() { return top; },
    set scrollTop(value: number) { top = Math.max(0, Math.min(value, height - this.clientHeight)); },
    addEventListener: (name: string, callback: () => void) => listeners.set(name, callback),
    removeEventListener: (name: string) => listeners.delete(name),
  };
  return {
    element: element as unknown as HTMLElement,
    content: {} as HTMLElement,
    scrollTo: (value: number) => { top = value; listeners.get("scroll")!(); },
    grow: (next: number) => { height = next; listeners.get("scroll")?.(); resize(); },
    shrink: (next: number) => { top = Math.min(top, next - clientHeight); height = next; listeners.get("scroll")?.(); resize(); },
    get top() { return top; },
    get listeners() { return listeners; },
    disconnect,
  };
}

it("starts on the newest line and follows new content", () => {
  const box = harness();
  const controller = followTranscript(box.element, box.content);
  expect(box.top).toBe(700);
  box.grow(1400);
  expect(box.top).toBe(1100);
  expect(controller.isPinned()).toBe(true);
  box.grow(2400);
  expect(box.top).toBe(2100);
});

it("stops following once the reader scrolls up, and resumes at the tail", () => {
  const box = harness();
  const controller = followTranscript(box.element, box.content);
  box.scrollTo(200); // Reader dragged back through the history.
  expect(controller.isPinned()).toBe(false);
  box.grow(1800);
  expect(box.top).toBe(200);
  box.scrollTo(1500);
  expect(controller.isPinned()).toBe(true);
  box.grow(2200);
  expect(box.top).toBe(1900);
});

it("keeps following when the content only changes height", () => {
  const box = harness();
  const controller = followTranscript(box.element, box.content);
  box.shrink(900); // Switching to a shorter tab must not look like scrolling up.
  expect(controller.isPinned()).toBe(true);
  box.grow(1500);
  expect(box.top).toBe(1200);
});

it("jumps to the newest line when the page pins explicitly", () => {
  const box = harness();
  const controller = followTranscript(box.element, box.content);
  box.scrollTo(0);
  expect(controller.isPinned()).toBe(false);
  controller.pin();
  expect(box.top).toBe(700);
  expect(controller.isPinned()).toBe(true);
  box.grow(2000);
  expect(box.top).toBe(1700);
});

it("cleans up its observer and listener", () => {
  const box = harness();
  const controller = followTranscript(box.element, box.content);
  controller.dispose();
  expect(box.disconnect).toHaveBeenCalledOnce();
  expect(box.listeners.size).toBe(0);
});
