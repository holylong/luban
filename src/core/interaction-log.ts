import { randomUUID } from "node:crypto";
import { appendFileSync, chmodSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import type { LubanConfig } from "./types.js";

/** Log caller-selected logical payloads, never transport/auth configuration. */
export async function interactionCompletion<T extends { content: string; reasoning: string; toolCalls: unknown; usage: unknown }>(
  config: LubanConfig, transport: string, attempt: number, request: unknown, complete: () => Promise<T>, secrets: string[] = [],
): Promise<T> {
  if (!config.interactionLog?.enabled) return complete();
  const requestId = randomUUID();
  const redact = (text: string) => [config.model.apiKey, ...secrets].filter(Boolean)
    .reduce((value, secret) => value.split(secret).join("[REDACTED]"), text);
  const write = (event: string, payload?: unknown) => {
    try {
      const directory = join(config.home, "logs", "interactions");
      const file = join(directory, `${new Date().toISOString().slice(0, 10)}.jsonl`);
      mkdirSync(directory, { recursive: true, mode: 0o700 });
      chmodSync(directory, 0o700);
      const row = { timestamp: new Date().toISOString(), requestId, attempt,
        provider: config.model.provider, model: config.model.model, transport, event,
        ...(payload === undefined ? {} : { body: Buffer.from(redact(JSON.stringify(payload))).toString("base64"), encoding: "base64" }) };
      appendFileSync(file, redact(JSON.stringify(row)) + "\n", { mode: 0o600 });
      chmodSync(file, 0o600);
    } catch { /* Logging must not affect completion or expose exception text. */ }
  };
  write("request", request);
  try {
    const result = await complete();
    write("reply", { content: result.content, reasoning: result.reasoning, toolCalls: result.toolCalls, usage: result.usage });
    write("end");
    return result;
  } catch (error) { write("completion_error"); throw error; }
}

/** Capture only consumed bytes, never tee/clone or accumulate a whole response. */
export async function interactionFetch(config: LubanConfig, attempt: number, input: string, init: RequestInit): Promise<Response> {
  if (!config.interactionLog?.enabled) return fetch(input, init);
  const requestId = randomUUID();
  const secret = Buffer.from(config.model.apiKey || "");
  const directory = join(config.home, "logs", "interactions");
  const file = join(directory, `${new Date().toISOString().slice(0, 10)}.jsonl`);
  const redact = (bytes: Buffer): Buffer => {
    if (!secret.length) return bytes;
    const parts: Buffer[] = [];
    let start = 0;
    for (let index = bytes.indexOf(secret, start); index !== -1; index = bytes.indexOf(secret, start)) {
      parts.push(bytes.subarray(start, index), Buffer.from("[REDACTED]"));
      start = index + secret.length;
    }
    parts.push(bytes.subarray(start));
    return Buffer.concat(parts);
  };
  const write = (event: string, fields: Record<string, unknown> = {}) => {
    try {
      mkdirSync(directory, { recursive: true, mode: 0o700 });
      chmodSync(directory, 0o700);
      // No URLs, headers, auth metadata or exception messages are persisted.
      const line = JSON.stringify({ timestamp: new Date().toISOString(), requestId, attempt, provider: config.model.provider, model: config.model.model, event, ...fields });
      appendFileSync(file, redact(Buffer.from(line)).toString("utf8") + "\n", { mode: 0o600 });
      chmodSync(file, 0o600);
    } catch { /* Diagnostic logging must never break model transport. */ }
  };
  write("request", { body: redact(Buffer.from(typeof init.body === "string" ? init.body : "")).toString("base64"), encoding: "base64" });
  let response: Response;
  try { response = await fetch(input, init); }
  catch (error) { write("transport_error"); throw error; }
  write("response", { status: response.status });
  if (!response.body) { write("end"); return response; }
  const reader = response.body.getReader();
  let pending = Buffer.alloc(0);
  const capture = (bytes: Uint8Array, final = false) => {
    pending = Buffer.concat([pending, bytes]);
    let end = final ? pending.length : Math.max(0, pending.length - secret.length + 1);
    // Keep an entire key when its prefix straddles a chunk boundary.
    if (secret.length && !final) {
      for (let match = pending.indexOf(secret); match !== -1 && match < end; match = pending.indexOf(secret, match + secret.length)) {
        if (match + secret.length > end) { end = match; break; }
      }
    }
    if (end) write("response_bytes", { body: redact(pending.subarray(0, end)).toString("base64"), encoding: "base64" });
    pending = pending.subarray(end);
  };
  const body = new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        const { done, value } = await reader.read();
        if (done) { capture(new Uint8Array(), true); write("end"); controller.close(); }
        else { capture(value); controller.enqueue(value); }
      } catch (error) { capture(new Uint8Array(), true); write("stream_error"); controller.error(error); }
    },
    async cancel(reason) { capture(new Uint8Array(), true); write("cancel"); await reader.cancel(reason); },
  }, { highWaterMark: 0 });
  return new Response(body, { status: response.status, statusText: response.statusText, headers: response.headers });
}
