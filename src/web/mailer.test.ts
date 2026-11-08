import { describe, expect, it } from "vitest";
import { smtpFromEnv } from "./mailer.js";

describe("SMTP configuration", () => {
  it("is disabled unless both mailbox and app password are present", () => {
    expect(smtpFromEnv({})).toBeUndefined();
    expect(smtpFromEnv({ LUBAN_RELAY_SMTP_EMAIL: "sender@example.com" })).toBeUndefined();
    expect(smtpFromEnv({ LUBAN_RELAY_SMTP_PASSWORD: "secret" })).toBeUndefined();
  });

  it("defaults to 163 SMTPS and honours overrides", () => {
    expect(smtpFromEnv({
      LUBAN_RELAY_SMTP_EMAIL: " sender@example.com ",
      LUBAN_RELAY_SMTP_PASSWORD: " app-password ",
    })).toEqual({
      host: "smtp.163.com",
      port: 465,
      from: "sender@example.com",
      password: "app-password",
    });
    expect(smtpFromEnv({
      LUBAN_RELAY_SMTP_EMAIL: "sender@example.com",
      LUBAN_RELAY_SMTP_PASSWORD: "app-password",
      LUBAN_RELAY_SMTP_HOST: "smtp.example.com",
      LUBAN_RELAY_SMTP_PORT: "2465",
    })).toMatchObject({ host: "smtp.example.com", port: 2465 });
  });
});
