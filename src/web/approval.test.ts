import { describe, expect, it } from "vitest";
import { ApprovalBroker } from "./approval.js";
import type { ToolDefinition } from "../core/types.js";

describe("single-command web approvals", () => {
  it("rejects broad trust decisions while leaving the request pending for explicit approval", async () => {
    const broker = new ApprovalBroker();
    const tool: ToolDefinition = { name: "bash", description: "确认重启", risk: "execute", parameters: {}, approvalOnceOnly: true,
      async execute() { return "unused"; } };
    const result = broker.request("job", tool, { command: "reboot" });
    const request = broker.pending()[0]!;
    expect(request.once_only).toBe(true);
    expect(broker.decide(request.id, "always")).toBe(false);
    expect(broker.decide(request.id, "tool")).toBe(false);
    expect(broker.pending()).toHaveLength(1);
    expect(broker.decide(request.id, "once")).toBe(true);
    expect(await result).toBe("once");
    expect(broker.pending()).toHaveLength(0);
  });
});
