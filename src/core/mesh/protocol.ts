import { createHmac, randomUUID, timingSafeEqual } from "node:crypto";
import { createConnection } from "node:net";

export const PROTOCOL_VERSION = 1;
export const MAX_FRAME_SIZE = 64 * 1024 * 1024;

export type JsonObject = Record<string, unknown>;

export interface MeshEnvelope extends JsonObject {
  v: number;
  type: string;
  id: string;
  reply_to: string | null;
  from: string;
  to: string;
  ts: number;
  payload: JsonObject;
  expect_reply?: boolean;
  auth?: string;
}

export function envelope(
  type: string,
  from: string,
  to = "",
  payload: JsonObject = {},
  replyTo: string | null = null,
): MeshEnvelope {
  return {
    v: PROTOCOL_VERSION,
    type,
    id: randomUUID().replaceAll("-", "").slice(0, 16),
    reply_to: replyTo,
    from,
    to,
    ts: Date.now() / 1000,
    payload,
  };
}

export function encodeFrame(value: JsonObject): Buffer {
  const body = Buffer.from(JSON.stringify(value), "utf8");
  if (!body.length || body.length > MAX_FRAME_SIZE) {
    throw new Error(`protocol frame too large: ${body.length} bytes`);
  }
  const head = Buffer.allocUnsafe(4);
  head.writeUInt32BE(body.length);
  return Buffer.concat([head, body]);
}

export function decodeFrames(buffer: Buffer): { messages: JsonObject[]; remaining: Buffer } {
  const messages: JsonObject[] = [];
  let offset = 0;
  while (buffer.length - offset >= 4) {
    const size = buffer.readUInt32BE(offset);
    if (size <= 0 || size > MAX_FRAME_SIZE) throw new Error(`invalid protocol frame size: ${size}`);
    if (buffer.length - offset < 4 + size) break;
    const value = JSON.parse(buffer.subarray(offset + 4, offset + 4 + size).toString("utf8")) as unknown;
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("protocol frame is not an object");
    messages.push(value as JsonObject);
    offset += 4 + size;
  }
  return { messages, remaining: buffer.subarray(offset) };
}

function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(Object.keys(value as JsonObject).sort().map((key) => [key, canonical((value as JsonObject)[key])]));
}

/** Matches Python json.dumps(sort_keys=True, ensure_ascii=False, separators=(",", ":")). */
export function canonicalJson(value: JsonObject): string {
  return JSON.stringify(canonical(value));
}

export function signObject(value: JsonObject, token: string): string {
  const unsigned = Object.fromEntries(Object.entries(value).filter(([key]) => key !== "auth"));
  return createHmac("sha256", token).update(canonicalJson(unsigned)).digest("hex");
}

export function verifySignature(value: JsonObject, token: string): boolean {
  if (!token) return true;
  const supplied = typeof value.auth === "string" ? value.auth : "";
  if (!/^[a-f0-9]{64}$/iu.test(supplied)) return false;
  const expected = signObject(value, token);
  return timingSafeEqual(Buffer.from(supplied, "hex"), Buffer.from(expected, "hex"));
}

export function sendRpc(
  host: string,
  port: number,
  message: JsonObject,
  timeoutMs = 15_000,
  signal?: AbortSignal,
): Promise<JsonObject> {
  return new Promise<JsonObject>((resolve, reject) => {
    let settled = false;
    let connected = false;
    let buffer: Buffer = Buffer.alloc(0);
    const socket = createConnection({ host, port });
    const finish = (error?: Error, reply?: JsonObject) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener("abort", abort);
      socket.destroy();
      if (error) reject(error);
      else if (reply) resolve(reply);
      else reject(new Error(`no reply from ${host}:${port}`));
    };
    const abort = () => finish(signal?.reason instanceof Error ? signal.reason : new Error("mesh request aborted"));
    // The two failures look identical to a user but have opposite causes, so
    // the message says which one happened: a connection that never opened is a
    // routing/firewall problem, while one that opened and then went silent
    // means something else answered — a proxy or VPN intercepting the address,
    // another service on that port, or a node listening on a different port.
    const timer = setTimeout(() => finish(new Error(connected
      ? `mesh request to ${host}:${port} connected but no reply within ${timeoutMs / 1000}s: the port is open but is not answering as a luban node (a proxy/VPN may be intercepting ${host}, another service may hold the port, or the peer runs on a different port)`
      : `mesh request to ${host}:${port} could not be reached within ${timeoutMs / 1000}s: no route, blocked by a firewall, or the peer is not running`)), timeoutMs);
    signal?.addEventListener("abort", abort, { once: true });
    if (signal?.aborted) {
      abort();
      return;
    }
    socket.on("connect", () => { connected = true; socket.write(encodeFrame(message)); });
    socket.on("data", (chunk) => {
      buffer = Buffer.concat([buffer, chunk]);
      try {
        const decoded = decodeFrames(buffer);
        buffer = decoded.remaining;
        if (decoded.messages[0]) finish(undefined, decoded.messages[0]);
      } catch (error) {
        finish(error instanceof Error ? error : new Error(String(error)));
      }
    });
    socket.on("error", (error) => finish(new Error(`${host}:${port}: ${error.message}`)));
    socket.on("end", () => finish(new Error(`connection ${host}:${port} closed before reply`)));
  });
}
