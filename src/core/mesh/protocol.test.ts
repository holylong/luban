import { createHmac } from "node:crypto";
import { createServer } from "node:net";
import type { AddressInfo } from "node:net";
import { describe, expect, it } from "vitest";
import { canonicalJson, decodeFrames, encodeFrame, sendRpc, signObject, verifySignature } from "./protocol.js";

describe("Python-compatible mesh protocol", () => {
  it("encodes and incrementally decodes length-prefixed JSON frames", () => {
    const first = encodeFrame({ type: "ping", payload: { text: "你好" } });
    const second = encodeFrame({ ok: true });
    const partial = decodeFrames(Buffer.concat([first, second.subarray(0, 3)]));
    expect(partial.messages).toEqual([{ type: "ping", payload: { text: "你好" } }]);
    const complete = decodeFrames(Buffer.concat([partial.remaining, second.subarray(3)]));
    expect(complete.messages).toEqual([{ ok: true }]);
  });

  it("uses the same recursive sorted-key HMAC representation as Python", () => {
    const value = { z: 2, payload: { b: "中文", a: [3, { y: 2, x: 1 }] }, auth: "old" };
    const expectedJson = '{"payload":{"a":[3,{"x":1,"y":2}],"b":"中文"},"z":2}';
    expect(canonicalJson({ z: 2, payload: value.payload })).toBe(expectedJson);
    const expected = createHmac("sha256", "secret").update(expectedJson).digest("hex");
    const signed = { ...value, auth: signObject(value, "secret") };
    expect(signed.auth).toBe(expected);
    expect(verifySignature(signed, "secret")).toBe(true);
  });
});

describe("mesh request diagnostics", () => {
  it("distinguishes a silent listener from an unreachable host", async () => {
    // A port that accepts the connection and never answers is what a proxy/VPN
    // hijack looks like; an unreachable host fails differently. The two used to
    // produce the same "timed out" text.
    const server = createServer(() => { /* accept and stay silent */ });
    await new Promise<void>((ready) => server.listen(0, "127.0.0.1", ready));
    const port = (server.address() as AddressInfo).port;
    try {
      await expect(sendRpc("127.0.0.1", port, { type: "ping" }, 300)).rejects.toThrow(/connected but no reply/u);
    } finally {
      server.close();
    }
  });

  it("reports an unreachable address without claiming it connected", async () => {
    // Port 1 on loopback is closed, so the connection never opens.
    await expect(sendRpc("127.0.0.1", 1, { type: "ping" }, 500)).rejects.toThrow(/could not be reached|ECONNREFUSED/u);
  });
});
