import { describe, expect, it } from "vitest";
import { planTools, planVerificationStatus, readVerifications } from "./plan.js";
import type { ChatMessage } from "./types.js";

describe("plan verification log", () => {
  it("requires a passing check before reporting verified", async () => {
    const messages: ChatMessage[] = [{ role: "system", content: "root" }];
    const [update, , record] = planTools(messages);
    await update!.execute({ plan: [{ step: "fix bug", status: "completed" }] }, new AbortController().signal);
    expect(planVerificationStatus(messages).verified).toBe(false);
    await record!.execute({ command: "npm test", status: "failed", output: "1 failing" }, new AbortController().signal);
    expect(planVerificationStatus(messages).verified).toBe(false);
    expect(readVerifications(messages)).toHaveLength(1);
    await record!.execute({ command: "npm test", status: "passed", output: "all green" }, new AbortController().signal);
    const status = planVerificationStatus(messages);
    expect(status.verified).toBe(true);
    expect(status.detail).toMatch(/passing check/);
  });
});
