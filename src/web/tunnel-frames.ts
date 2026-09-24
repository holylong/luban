/**
 * Wire format for the relay tunnel.
 *
 * One frame is `type(1) | length(4, big-endian) | payload(length)`. The same
 * bytes travel in both directions:
 *
 *   phone ──────────────► relay ──poll──► node   (request envelope, JSON)
 *   phone ◄──frames────── relay ◄─reply── node   (head / chunk / end / fail)
 *
 * A framing layer (instead of one JSON document per response) is what lets an
 * SSE response reach the phone while it is still being produced: the node keeps
 * writing CHUNK frames, and the relay forwards each one as it arrives.
 */

export const FRAME_HEAD = 1;
export const FRAME_CHUNK = 2;
export const FRAME_END = 3;
export const FRAME_FAIL = 4;

export type FrameType = typeof FRAME_HEAD | typeof FRAME_CHUNK | typeof FRAME_END | typeof FRAME_FAIL;

export interface Frame {
  type: FrameType;
  payload: Buffer;
}

export interface ResponseHead {
  status: number;
  headers: Record<string, string>;
}

export interface EndPayload {
  /** Chunks the peer may have dropped, so the reader does not report a clean EOF. */
  truncated?: boolean;
}

export interface FailPayload {
  message: string;
}

/** Payload cap: a single tool result or log line, not a whole file transfer. */
export const MAX_FRAME_BYTES = 4 * 1024 * 1024;

export function encodeFrame(type: FrameType, payload: Buffer | string = Buffer.alloc(0)): Buffer {
  const body = Buffer.isBuffer(payload) ? payload : Buffer.from(payload, "utf8");
  if (body.length > MAX_FRAME_BYTES) throw new Error(`frame payload too large (${body.length} bytes)`);
  const header = Buffer.allocUnsafe(5);
  header.writeUInt8(type, 0);
  header.writeUInt32BE(body.length, 1);
  return Buffer.concat([header, body]);
}

export function encodeJsonFrame(type: FrameType, value: unknown): Buffer {
  return encodeFrame(type, Buffer.from(JSON.stringify(value), "utf8"));
}

/**
 * Incremental decoder.
 *
 * Node does not guarantee that one TCP read equals one write, so partial
 * headers and payloads have to be held across reads. The decoder is a closure
 * rather than a class because the relay keeps one per in-flight response.
 */
export function createFrameDecoder(): (chunk: Buffer) => Frame[] {
  let buffer: Buffer = Buffer.alloc(0);
  return (chunk: Buffer): Frame[] => {
    buffer = buffer.length ? Buffer.concat([buffer, chunk]) : Buffer.from(chunk);
    const frames: Frame[] = [];
    for (;;) {
      if (buffer.length < 5) break;
      const type = buffer.readUInt8(0) as FrameType;
      const length = buffer.readUInt32BE(1);
      if (length > MAX_FRAME_BYTES) throw new Error(`frame payload too large (${length} bytes)`);
      if (buffer.length < 5 + length) break;
      frames.push({ type, payload: buffer.subarray(5, 5 + length) });
      buffer = buffer.subarray(5 + length);
    }
    return frames;
  };
}

export function parseJson<T>(payload: Buffer): T {
  return JSON.parse(payload.toString("utf8")) as T;
}

/**
 * Request envelope handed to a node by the relay.
 *
 * Headers are pre-filtered by the relay: hop-by-hop headers, cookies and the
 * relay's own credentials must not reach the node, which is why they are not
 * forwarded verbatim.
 */
export interface TunnelRequestMessage {
  type: "request";
  id: string;
  method: string;
  path: string;
  headers: Record<string, string>;
  /** Base64 so binary uploads survive the JSON envelope. */
  body?: string;
}

/** A phone walked away or hit stop: drop the matching local request. */
export interface TunnelAbortMessage {
  type: "abort";
  id: string;
}

export type TunnelMessage = TunnelRequestMessage | TunnelAbortMessage;

/**
 * Credentials the relay itself uses. They are stripped from both directions so a
 * phone can never hand a node token to the node's API, and a node's token never
 * appears in an answer.
 */
const RELAY_CREDENTIALS = new Set(["x-luban-node-token", "x-luban-node-id", "x-luban-token", "authorization"]);

/** Headers that must not be replayed to the local server or back to the phone. */
const HOP_BY_HOP = new Set([
  "connection", "keep-alive", "proxy-authenticate", "proxy-authorization",
  "te", "trailer", "transfer-encoding", "upgrade", "host", "content-length",
  "accept-encoding",
]);

export function filterForwardedHeaders(headers: NodeJS.Dict<string | string[]>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [name, value] of Object.entries(headers)) {
    const key = name.toLowerCase();
    if (HOP_BY_HOP.has(key) || RELAY_CREDENTIALS.has(key)) continue;
    if (key === "cookie") continue;
    if (value === undefined) continue;
    out[key] = Array.isArray(value) ? value.join(", ") : value;
  }
  return out;
}

export function filterResponseHeaders(headers: NodeJS.Dict<string | string[]>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [name, value] of Object.entries(headers)) {
    const key = name.toLowerCase();
    if (HOP_BY_HOP.has(key) || RELAY_CREDENTIALS.has(key) || key === "set-cookie") continue;
    if (value === undefined) continue;
    out[key] = Array.isArray(value) ? value.join(", ") : value;
  }
  return out;
}
