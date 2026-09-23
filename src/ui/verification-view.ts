import type { VerificationRecord } from "../core/types.js";

export interface VerificationSummary {
  total: number;
  passed: number;
  failed: number;
  /** Server-side gate: only true when every completed plan step has a passing check. */
  verified: boolean;
  detail: string;
}

/** Counts for the verification panel header and the plan sidebar gate. */
export function verificationSummary(records: VerificationRecord[], gate: { verified: boolean; detail: string }): VerificationSummary {
  const passed = records.filter((record) => record.status === "passed").length;
  return { total: records.length, passed, failed: records.length - passed, verified: gate.verified, detail: gate.detail };
}

/** The records the panel renders, newest last, bounded to what fits on screen. */
export function visibleVerifications(records: VerificationRecord[], limit = 12): VerificationRecord[] {
  return limit > 0 ? records.slice(-limit) : [...records];
}

export function verificationHeadline(summary: VerificationSummary): string {
  const parts = [`${summary.total} 次`];
  if (summary.passed) parts.push(`${summary.passed} 通过`);
  if (summary.failed) parts.push(`${summary.failed} 失败`);
  return parts.join(" · ");
}

/** One-line evidence for a record: status, command and its first output line. */
export function verificationLine(record: VerificationRecord, width = 100): { marker: string; command: string; output: string; at: string } {
  const flatten = (value: string): string => value.trim().replaceAll(/\s+/gu, " ");
  const clip = (value: string, size: number): string => value.length > size ? `${value.slice(0, size - 1)}…` : value;
  return {
    marker: record.status === "passed" ? "✓" : "✗",
    command: clip(flatten(record.command), width),
    output: clip(flatten(record.output), width),
    at: record.createdAt.slice(0, 19).replace("T", " "),
  };
}
