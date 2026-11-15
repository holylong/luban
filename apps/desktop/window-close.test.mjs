import { EventEmitter } from "node:events";
import test from "node:test";
import assert from "node:assert/strict";
import { hideForTray } from "./window-close.cjs";
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));

/** A window-shaped fake: just the four calls hideForTray is allowed to make. */
function fakeWindow({ fullscreen = false, destroyed = false } = {}) {
  const win = new EventEmitter();
  win.calls = [];
  win.destroyed = destroyed;
  win.isDestroyed = () => win.destroyed;
  win.isFullScreen = () => win.fullScreen;
  win.setFullScreen = value => { win.calls.push(["setFullScreen", value]); win.fullScreen = value; };
  win.hide = () => { win.calls.push(["hide"]); };
  win.fullScreen = fullscreen;
  return win;
}

test("an ordinary window is hidden at once", () => {
  const win = fakeWindow();
  assert.equal(hideForTray(win), true);
  assert.deepEqual(win.calls, [["hide"]]);
});

test("a full-screen window leaves full screen before it hides", async () => {
  const win = fakeWindow({ fullscreen: true });
  hideForTray(win);
  // Hiding first is exactly the bug: the macOS Space stayed black and occupied.
  assert.deepEqual(win.calls, [["setFullScreen", false]]);
  win.emit("leave-full-screen");
  await wait(150);
  assert.deepEqual(win.calls, [["setFullScreen", false], ["hide"]]);
});

test("a window that never reports leaving still gets hidden", async () => {
  const win = fakeWindow({ fullscreen: true });
  hideForTray(win, { fallbackMs: 20 });
  await wait(200);
  assert.deepEqual(win.calls, [["setFullScreen", false], ["hide"]]);
});

test("a window destroyed mid-transition is never touched again", async () => {
  const win = fakeWindow({ fullscreen: true });
  hideForTray(win);
  win.destroyed = true;
  win.emit("leave-full-screen");
  await wait(150);
  assert.deepEqual(win.calls, [["setFullScreen", false]]);
});

test("an already destroyed window is left alone", () => {
  const win = fakeWindow({ destroyed: true });
  assert.equal(hideForTray(win), false);
  assert.deepEqual(win.calls, []);
});
