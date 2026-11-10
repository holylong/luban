import { describe, expect, it } from "vitest";
import { watchParent } from "./parent-watch.js";

function harness(watchPid: number, startPpid = watchPid) {
  let ppid = startPpid;
  const exits: number[] = [];
  let gone = 0;
  const stop = watchParent(watchPid, {
    ppid: () => ppid,
    exit: code => exits.push(code),
    intervalMs: 5,
    onParentGone: () => { gone += 1; },
  });
  return {
    reparent(next: number) { ppid = next; },
    stop,
    get exits() { return exits; },
    get gone() { return gone; },
  };
}

const settle = (ms = 40) => new Promise(resolve => setTimeout(resolve, ms));

describe("watchParent", () => {
  it("ends the backend once its parent is gone", async () => {
    const watch = harness(4242);
    await settle();
    expect(watch.exits).toEqual([]);
    watch.reparent(1);
    await settle();
    expect(watch.exits).toEqual([0]);
    expect(watch.gone).toBe(1);
  });

  it("exits once, not on every tick", async () => {
    const watch = harness(4242);
    watch.reparent(1);
    await settle();
    await settle();
    expect(watch.exits).toEqual([0]);
  });

  it("does nothing when the given pid is not our parent", async () => {
    const watch = harness(4242, 7);      // asked to watch another process
    await settle();
    expect(watch.exits).toEqual([]);
    watch.reparent(8);
    await settle();
    expect(watch.exits).toEqual([]);
  });

  it("ignores invalid pids and stops cleanly", async () => {
    for (const pid of [0, -1, Number.NaN]) {
      const exits: number[] = [];
      watchParent(pid, { ppid: () => pid, exit: code => exits.push(code), intervalMs: 5 });
      await settle(20);
      expect(exits).toEqual([]);
    }
    const watch = harness(99);
    watch.stop();
    watch.reparent(1);
    await settle();
    expect(watch.exits).toEqual([]);
  });
});
