import { describe, expect, it } from "vitest";
import type { VerificationRecord } from "../core/types.js";
import { planVerificationStatus } from "../core/plan.js";
import { verificationHeadline, verificationLine, verificationSummary, visibleVerifications } from "./verification-view.js";

function record(index: number, status: "passed" | "failed", output = ""): VerificationRecord {
  return { id: `v${index}`, command: `npm test -- ${index}`, status, output, createdAt: `2026-09-15T10:0${index}:00.000Z` };
}

const gate = (verified: boolean, detail = "detail") => ({ verified, detail });

describe("verificationSummary", () => {
  it("counts passing and failing records", () => {
    const summary = verificationSummary([record(1, "passed"), record(2, "failed"), record(3, "passed")], gate(true));
    expect(summary).toEqual({ total: 3, passed: 2, failed: 1, verified: true, detail: "detail" });
  });

  it("reports an empty session with the gate still closed", () => {
    expect(verificationSummary([], gate(false, "no plan"))).toEqual({ total: 0, passed: 0, failed: 0, verified: false, detail: "no plan" });
  });
});

describe("verificationHeadline", () => {
  it("omits zero counters so the header stays short", () => {
    expect(verificationHeadline(verificationSummary([record(1, "passed")], gate(true)))).toBe("1 次 · 1 通过");
    expect(verificationHeadline(verificationSummary([record(1, "failed")], gate(false)))).toBe("1 次 · 1 失败");
    expect(verificationHeadline(verificationSummary([], gate(false)))).toBe("0 次");
  });
});

describe("visibleVerifications", () => {
  it("keeps the newest records when the list is longer than the panel", () => {
    const records = Array.from({ length: 20 }, (_, index) => record(index % 10, "passed"));
    const visible = visibleVerifications(records, 5);
    expect(visible).toHaveLength(5);
    expect(visible.at(-1)).toBe(records.at(-1));
    expect(visible[0]).toBe(records[15]);
  });

  it("returns everything when the limit is not positive", () => {
    const records = [record(1, "passed"), record(2, "failed")];
    expect(visibleVerifications(records, 0)).toHaveLength(2);
  });
});

describe("verificationLine", () => {
  it("flattens multi-line output and clips to the requested width", () => {
    const line = verificationLine({ ...record(1, "failed"), command: "npm test", output: "line one\nline two\nline three" }, 20);
    expect(line.marker).toBe("✗");
    expect(line.output).toBe("line one line two l…");
    expect(line.at).toBe("2026-09-15 10:01:00");
  });

  it("keeps a passing record marked as passing", () => {
    expect(verificationLine(record(1, "passed")).marker).toBe("✓");
  });
});

describe("plan verification gate", () => {
  const marker = "[luban task plan]";
  const verificationMarker = "[luban verification]";

  it("stays closed when completed steps have no recorded check", () => {
    const messages = [{ role: "system" as const, content: `${marker}${JSON.stringify({ explanation: "", plan: [{ step: "edit", status: "completed" }] })}` }];
    const status = planVerificationStatus(messages);
    expect(status.verified).toBe(false);
    expect(status.detail).toContain("no verification recorded");
  });

  it("stays closed when the only recorded check failed", () => {
    const messages = [
      { role: "system" as const, content: `${marker}${JSON.stringify({ explanation: "", plan: [{ step: "edit", status: "completed" }] })}` },
      { role: "system" as const, content: `${verificationMarker}${JSON.stringify(record(1, "failed"))}` },
    ];
    const status = planVerificationStatus(messages);
    expect(status.verified).toBe(false);
    expect(status.detail).toContain("failed");
  });

  it("opens once a completed step has a passing check", () => {
    const messages = [
      { role: "system" as const, content: `${marker}${JSON.stringify({ explanation: "", plan: [{ step: "edit", status: "completed" }] })}` },
      { role: "system" as const, content: `${verificationMarker}${JSON.stringify([record(1, "passed")])}` },
    ];
    const status = planVerificationStatus(messages);
    expect(status.verified).toBe(true);
    expect(status.detail).toContain("passing check");
  });
});
