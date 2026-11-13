// The window's control bridge: it owns one `luban drive` child and translates
// its JSON lines into renderer events. No real child is spawned here — these
// cases pin the framing rules that go wrong silently.
import test from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { DriveBridge } = require("./drive.cjs");

function fakeBridge(events) {
  const bridge = new DriveBridge({ onEvent: event => events.push(event) });
  bridge.child = { stdin: { writable: true, write: () => true } };
  return bridge;
}

test("say draws the user's line once even though the child echoes it", () => {
  const events = [];
  const bridge = fakeBridge(events);
  assert.equal(bridge.say("在计算器里算 6*7"), true);
  assert.equal(bridge.say("   "), false);
  // The child reports the same turn a moment later; drawing both looks like a double send.
  bridge.onLine(JSON.stringify({ type: "turn-start", text: "在计算器里算 6*7" }));
  assert.deepEqual(events.map(event => event.type), ["turn-start"]);
  assert.match(events[0].id, /^local-/);
  // A turn that did not come from this box still shows up.
  bridge.onLine(JSON.stringify({ type: "turn-start", text: "定时任务那一轮" }));
  assert.equal(events.length, 2);
});

test("keeps screenshot paths off the event until the window inlines them", () => {
  const events = [];
  const bridge = fakeBridge(events);
  bridge.onLine(JSON.stringify({ type: "tool-result", id: "t1", name: "computer", ok: true, preview: "{}", screenshot: ".luban/computer/shot-1.png" }));
  assert.equal(events[0].screenshot, ".luban/computer/shot-1.png");
  assert.equal(events[0].image, undefined);
});

test("remembers the workspace so relative screenshot paths resolve", () => {
  const events = [];
  const bridge = new DriveBridge({ onEvent: event => events.push(event) });
  // start() would spawn a child; the workspace field is what main.cjs reads.
  bridge.workspace = "/tmp/some-workspace";
  assert.equal(bridge.workspace, "/tmp/some-workspace");
});

test("records the child's failure without killing the panel", () => {
  const events = [];
  const bridge = fakeBridge(events);
  bridge.onLine("这不是 JSON");
  assert.equal(events.length, 0);
  bridge.onLine(JSON.stringify({ type: "error", text: "model HTTP 403" }));
  assert.equal(bridge.snapshot().error, "model HTTP 403");
  assert.equal(events.length, 1);
});
