import { describe, expect, it } from "vitest";
import { decodeCommand, encodeEvent, parseAllowlist, pumpCommands, type CommandTarget } from "./drive-command.js";
import type { DriveEvent } from "./drive.js";

/** Feed the pump a fixed list of stdin lines. */
async function* lines(...items: string[]): AsyncIterable<string> {
  for (const item of items) yield item;
}

describe("drive command framing", () => {
  it("round-trips events and drops commands it cannot read", () => {
    expect(encodeEvent({ type: "status", text: "hi" })).toBe('{"type":"status","text":"hi"}\n');
    expect(decodeCommand('{"type":"say","text":"打开计算器"}')).toEqual({ type: "say", text: "打开计算器" });
    expect(decodeCommand('{"type":"approve","id":"a1","allow":true}')).toEqual({ type: "approve", id: "a1", allow: true });
    expect(decodeCommand('{"type":"say","text":"   "}')).toBeUndefined();
    expect(decodeCommand("not json")).toBeUndefined();
    expect(decodeCommand('{"type":"nope"}')).toBeUndefined();
  });
});

describe("pumpCommands", () => {
  it("reads a standing 允许 list without letting junk widen it", () => {
    expect(parseAllowlist("computer,bash")).toEqual(["computer", "bash"]);
    expect(parseAllowlist(" computer , , bash ,computer")).toEqual(["computer", "bash"]);
    expect(parseAllowlist("rm -rf /;computer")).toEqual([]);
    expect(parseAllowlist(undefined)).toEqual([]);
  });
  it("answers an approval while the turn that raised it is still waiting", async () => {
    // The real deadlock: `approve` used to sit behind the `say` it unblocks, so
    // every turn that touched the screen waited for a reply that never arrived.
    const events: DriveEvent[] = [];
    let released: (() => void) | undefined;
    const order: string[] = [];
    const session: CommandTarget = {
      busy: false,
      state: {},
      say: () => new Promise<void>(resolve => { released = resolve; order.push("say-start"); }),
      approve: (id, allow) => { order.push(`approve ${id} ${allow}`); released?.(); return true; },
      stop: () => { order.push("stop"); },
    };
    await pumpCommands(session, event => events.push(event), lines(
      '{"type":"say","text":"打开计算器"}',
      '{"type":"approve","id":"a1","allow":true}',
    ), { workspace: "/tmp", model: "test/model" });
    expect(order).toEqual(["say-start", "approve a1 true"]);
    expect(events).toHaveLength(0);
  });

  it("stops a running turn without waiting for it to finish", async () => {
    const order: string[] = [];
    let released: (() => void) | undefined;
    const session: CommandTarget = {
      busy: false,
      state: {},
      say: () => new Promise<void>(resolve => { released = resolve; }),
      approve: () => false,
      stop: () => { order.push("stop"); released?.(); },
    };
    await pumpCommands(session, () => undefined, lines(
      '{"type":"say","text":"点一下"}',
      '{"type":"stop"}',
    ), { workspace: "/tmp", model: "test/model" });
    expect(order).toEqual(["stop"]);
  });

  it("runs turns one at a time and answers status in between", async () => {
    const events: DriveEvent[] = [];
    const started: string[] = [];
    let busy = false;
    const session: CommandTarget = {
      get busy() { return busy; },
      state: { supported: true, enabled: true },
      say: text => {
        started.push(text);
        busy = true;
        // A turn that takes a moment: the second say must still wait for it.
        return new Promise<void>(resolve => setTimeout(() => { busy = false; resolve(); }, 5));
      },
      approve: () => false,
      stop: () => undefined,
    };
    await pumpCommands(session, event => events.push(event), lines(
      '{"type":"say","text":"一"}',
      '{"type":"say","text":"二"}',
      '{"type":"status"}',
    ), { workspace: "/tmp", model: "test/model" });
    expect(started).toEqual(["一", "二"]);
    const ready = events.find(event => event.type === "ready");
    expect(ready && ready.type === "ready" ? ready.workspace : "").toBe("/tmp");
  });
});
