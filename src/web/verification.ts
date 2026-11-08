import { createHash, randomInt, timingSafeEqual } from "node:crypto";
import { AccountError } from "./accounts.js";

/**
 * In-memory registration codes.
 *
 * A code is bound to one email, expires after ten minutes, allows five wrong
 * guesses, and can be sent at most five times an hour. Restarting the relay
 * invalidates outstanding codes on purpose: a code is a short-lived secret, not
 * part of the durable account file.
 */

const TTL_MS = 10 * 60 * 1000;
const RESEND_MS = 60 * 1000;
const MAX_SENDS_PER_HOUR = 5;
const MAX_ATTEMPTS = 5;

interface Entry {
  hash: Buffer;
  expires_at: number;
  attempts: number;
  sent_at: number[];
}

function hash(code: string): Buffer {
  return createHash("sha256").update(code).digest();
}

export class VerificationCodes {
  private readonly entries = new Map<string, Entry>();

  constructor(private readonly now: () => number = Date.now) {}

  /** Issue a six-digit code; throws 429 when the caller is resending too fast. */
  issue(email: string): string {
    const now = this.now();
    const existing = this.entries.get(email);
    const recent = (existing?.sent_at ?? []).filter(at => now - at < 60 * 60 * 1000);
    const last = recent.at(-1);
    if (last !== undefined && now - last < RESEND_MS) {
      throw new AccountError(429, "验证码发送过于频繁，请 60 秒后再试");
    }
    if (recent.length >= MAX_SENDS_PER_HOUR) {
      throw new AccountError(429, "验证码发送次数过多，请稍后再试");
    }
    const code = String(randomInt(0, 1_000_000)).padStart(6, "0");
    this.entries.set(email, {
      hash: hash(code),
      expires_at: now + TTL_MS,
      attempts: 0,
      sent_at: [...recent, now],
    });
    return code;
  }

  /** Check and consume a code. A successful code can never be replayed. */
  verify(email: string, code: string): boolean {
    const entry = this.entries.get(email);
    if (!entry) return false;
    if (this.now() > entry.expires_at) {
      this.entries.delete(email);
      return false;
    }
    entry.attempts += 1;
    if (entry.attempts > MAX_ATTEMPTS) {
      this.entries.delete(email);
      return false;
    }
    if (!/^\d{6}$/u.test(code) || !timingSafeEqual(entry.hash, hash(code))) return false;
    this.entries.delete(email);
    return true;
  }
}
