import { describe, expect, it } from "vitest";
import { VerificationCodes } from "./verification.js";
import { AccountError } from "./accounts.js";

describe("registration verification codes", () => {
  it("issues six digits and consumes a matching code once", () => {
    const codes = new VerificationCodes();
    const code = codes.issue("owner@example.com");
    expect(code).toMatch(/^\d{6}$/u);
    expect(codes.verify("owner@example.com", code)).toBe(true);
    expect(codes.verify("owner@example.com", code)).toBe(false);
  });

  it("binds the code to one address", () => {
    const codes = new VerificationCodes();
    const code = codes.issue("owner@example.com");
    expect(codes.verify("other@example.com", code)).toBe(false);
    expect(codes.verify("owner@example.com", code)).toBe(true);
  });

  it("rejects a code after five wrong attempts", () => {
    const codes = new VerificationCodes();
    const code = codes.issue("owner@example.com");
    const wrong = code === "000000" ? "111111" : "000000";
    for (let attempt = 0; attempt < 5; attempt += 1) expect(codes.verify("owner@example.com", wrong)).toBe(false);
    expect(codes.verify("owner@example.com", code)).toBe(false);
  });

  it("expires after ten minutes", () => {
    let now = 1_000_000;
    const codes = new VerificationCodes(() => now);
    const code = codes.issue("owner@example.com");
    now += 10 * 60 * 1000 + 1;
    expect(codes.verify("owner@example.com", code)).toBe(false);
  });

  it("rate-limits resends to one per minute", () => {
    let now = 1_000_000;
    const codes = new VerificationCodes(() => now);
    codes.issue("owner@example.com");
    expect(() => codes.issue("owner@example.com")).toThrow(AccountError);
    now += 60 * 1000;
    expect(() => codes.issue("owner@example.com")).not.toThrow();
  });

  it("rate-limits five sends per hour", () => {
    let now = 1_000_000;
    const codes = new VerificationCodes(() => now);
    for (let send = 0; send < 5; send += 1) {
      codes.issue("owner@example.com");
      now += 60 * 1000;
    }
    expect(() => codes.issue("owner@example.com")).toThrow("验证码发送次数过多");
  });
});
