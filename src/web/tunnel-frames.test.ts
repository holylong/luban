import { describe, expect, it } from "vitest";
import {
  createFrameDecoder, encodeFrame, encodeJsonFrame, filterForwardedHeaders, filterResponseHeaders,
  FRAME_CHUNK, FRAME_END, FRAME_HEAD, parseJson, type ResponseHead,
} from "./tunnel-frames.js";

describe("frame codec", () => {
  it("round-trips one frame", () => {
    const decode = createFrameDecoder();
    const [frame] = decode(encodeJsonFrame(FRAME_HEAD, { status: 200, headers: {} }));
    expect(frame!.type).toBe(FRAME_HEAD);
    expect(parseJson<ResponseHead>(frame!.payload).status).toBe(200);
  });

  it("keeps binary payloads byte-exact", () => {
    const payload = Buffer.from([0, 255, 1, 2, 0, 128]);
    const decode = createFrameDecoder();
    const [frame] = decode(encodeFrame(FRAME_CHUNK, payload));
    expect(Buffer.compare(frame!.payload, payload)).toBe(0);
  });

  it("decodes several frames from one read", () => {
    const decode = createFrameDecoder();
    const frames = decode(Buffer.concat([encodeFrame(FRAME_CHUNK, "a"), encodeFrame(FRAME_CHUNK, "b"), encodeJsonFrame(FRAME_END, {})]));
    expect(frames.map(frame => frame.type)).toEqual([FRAME_CHUNK, FRAME_CHUNK, FRAME_END]);
    expect(frames[1]!.payload.toString()).toBe("b");
  });

  it("waits for a frame that arrives split across reads", () => {
    const decode = createFrameDecoder();
    const frame = encodeFrame(FRAME_CHUNK, "hello world");
    // One byte at a time: TCP gives no framing guarantees of its own.
    let frames: ReturnType<ReturnType<typeof createFrameDecoder>> = [];
    for (const byte of frame) frames = frames.concat(decode(Buffer.from([byte])));
    expect(frames).toHaveLength(1);
    expect(frames[0]!.payload.toString()).toBe("hello world");
  });

  it("rejects an oversized declared payload instead of allocating it", () => {
    const header = Buffer.alloc(5);
    header.writeUInt8(FRAME_CHUNK, 0);
    header.writeUInt32BE(64 * 1024 * 1024, 1);
    expect(() => createFrameDecoder()(header)).toThrow(/too large/u);
  });
});

describe("header filtering", () => {
  it("drops hop-by-hop headers, cookies and relay credentials on the way in", () => {
    const headers = filterForwardedHeaders({
      host: "relay.local", connection: "keep-alive", cookie: "luban_token=secret",
      "x-luban-node-token": "node-secret", authorization: "Bearer phone-token",
      "content-type": "application/json", "x-custom": "kept",
    });
    expect(headers).toEqual({ "content-type": "application/json", "x-custom": "kept" });
  });

  it("drops framing headers and Set-Cookie on the way out", () => {
    const headers = filterResponseHeaders({
      "transfer-encoding": "chunked", "set-cookie": "luban_token=secret",
      "content-type": "text/event-stream", "cache-control": "no-cache",
    });
    expect(headers).toEqual({ "content-type": "text/event-stream", "cache-control": "no-cache" });
  });

  it("joins repeated headers", () => {
    expect(filterForwardedHeaders({ "x-many": ["a", "b"] })).toEqual({ "x-many": "a, b" });
  });
});
