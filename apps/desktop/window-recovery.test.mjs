import { test } from "node:test";
import assert from "node:assert/strict";
import { createRecoveryPolicy, DEFAULTS } from "./window-recovery.cjs";

const clock = start => {
  let at = start;
  return { now: () => at, advance: ms => { at += ms; } };
};

test("a lone renderer crash rebuilds the window instead of leaving a black board", () => {
  const policy = createRecoveryPolicy({ now: clock(0).now });
  assert.equal(policy.rendererGone(1), "recover-window");
});

test("a renderer crash loop restarts the app on the third crash inside the window", () => {
  const time = clock(0);
  const policy = createRecoveryPolicy({ now: time.now });
  assert.equal(policy.rendererGone(1), "recover-window");
  time.advance(1000);
  assert.equal(policy.rendererGone(1), "recover-window");
  assert.equal(policy.count(1), 2);
  time.advance(1000);
  assert.equal(policy.rendererGone(1), "relaunch-app");
});

test("crashes older than the window are forgotten", () => {
  const time = clock(0);
  const policy = createRecoveryPolicy({ now: time.now, windowMs: 60_000 });
  assert.equal(policy.rendererGone(1), "recover-window");
  assert.equal(policy.rendererGone(1), "recover-window");
  time.advance(DEFAULTS.windowMs);
  // The two old crashes fall out, so this one is a first crash again.
  assert.equal(policy.count(1), 0);
  assert.equal(policy.rendererGone(1), "recover-window");
});

test("two windows count their crashes separately", () => {
  const time = clock(0);
  const policy = createRecoveryPolicy({ now: time.now });
  policy.rendererGone(1);
  policy.rendererGone(1);
  time.advance(1000);
  assert.equal(policy.rendererGone(2), "recover-window");
  assert.equal(policy.rendererGone(3), "recover-window");
});

test("the second GPU crash asks for a software-compositor restart", () => {
  const time = clock(0);
  const policy = createRecoveryPolicy({ now: time.now });
  assert.equal(policy.gpuGone(), "recover-window");
  time.advance(2000);
  assert.equal(policy.gpuGone(), "relaunch-without-gpu");
});

test("a wedged renderer is rebuilt, and does not spend the renderer crash budget", () => {
  const time = clock(0);
  const policy = createRecoveryPolicy({ now: time.now });
  assert.equal(policy.unresponsive(1), "recover-window");
  assert.equal(policy.count(1, "unresponsive"), 1);
  assert.equal(policy.count(1, "renderer"), 0);
  time.advance(1000);
  assert.equal(policy.rendererGone(1), "recover-window");
});

test("a window that keeps wedging restarts the app on the third wedge", () => {
  const time = clock(0);
  const policy = createRecoveryPolicy({ now: time.now });
  assert.equal(policy.unresponsive(1), "recover-window");
  assert.equal(policy.unresponsive(1), "recover-window");
  assert.equal(policy.unresponsive(1), "relaunch-app");
});
