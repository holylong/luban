import { afterEach, expect, it } from "vitest";
import { installProcessGuard, processGuardInstalled, restoreProcessGuard } from "./process-guard.js";

// Restores the process-wide state each test mutated. Every test must call this
// or the guard leaks into the rest of the suite.
afterEach(() => { restoreProcessGuard(); });

it("reports an unhandled rejection instead of ending the process", async () => {
  const reported: string[] = [];
  const guard = installProcessGuard({ label: "mesh", report: (message) => { reported.push(message); } });
  // Rejection surfaces as an unhandledRejection event on the next microtask turn.
  void Promise.reject(new Error("scan failed: EACCES lost+found"));
  await new Promise((resolve) => { setTimeout(resolve, 10); });
  expect(reported.join("")).toMatch(/scan failed: EACCES/u);
  expect(reported.join("")).toContain("[mesh]");
  expect(guard.messages.some((line) => line.includes("EACCES"))).toBe(true);
});

it("keeps the process alive after an uncaught exception", () => {
  const reported: string[] = [];
  installProcessGuard({ report: (message) => { reported.push(message); } });
  // An uncaught exception must not reach the default handler that exits.
  expect(() => { process.emit("uncaughtException", new Error("boom"), "scan.js"); }).not.toThrow();
  expect(reported.join("")).toMatch(/boom/u);
});

it("does not double-install and restores cleanly", () => {
  const first: string[] = [];
  const second: string[] = [];
  const a = installProcessGuard({ report: (m) => { first.push(m); } });
  const b = installProcessGuard({ report: (m) => { second.push(m); } });
  expect(processGuardInstalled()).toBe(true);
  // A second subsystem must not stack a duplicate listener, so the first
  // reporter stays authoritative and the second one is ignored.
  process.emit("unhandledRejection", new Error("only once"), Promise.resolve());
  expect(first.join("")).toMatch(/only once/u);
  expect(second).toHaveLength(0);
  // Either handle can tear the guard down; neither may strand it installed.
  b.restore();
  expect(processGuardInstalled()).toBe(false);
  expect(() => { restoreProcessGuard(); }).not.toThrow();
});

it("survives a broken report sink", () => {
  installProcessGuard({ report: () => { throw new Error("stderr closed"); } });
  // A throwing reporter must not escalate back into process exit.
  expect(() => { process.emit("unhandledRejection", new Error("EACCES"), Promise.resolve()); }).not.toThrow();
});