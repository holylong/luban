import { readFileSync } from "node:fs";
import { expect, it } from "vitest";

const source = readFileSync(new URL("./mobile.tsx", import.meta.url), "utf8");
it("retains the task on transient failure and synchronizes detail without SSE", () => {
  expect(source).toContain('loadJob(id).catch(() => undefined); // Offline is not a deleted task.');
  expect(source).not.toContain('events.at(-1)?.seq');
  const sync = source.slice(source.indexOf('const sync = (): void => {'), source.indexOf('// Session detail is not'));
  expect(sync).toContain('loadJob(id)');
  for (const event of ['online', 'pageshow', 'visibilitychange']) expect(sync).toContain(`addEventListener("${event}"`);
});
it("lists the node's model catalog, switches it, and exposes reasoning effort", () => {
  expect(source).toContain("const modelCatalog = node?.models ?? []");
  expect(source).toContain("await api.setModel(id, effort)");
  expect(source).toContain("activeModel?.reasoning_efforts");
  expect(source).toContain("电脑端新增或切换模型后，这里会自动同步");
  expect(source).toContain('aria-label="模型"');
});
it("persists uncertainty before submitting and saves the accepted ID before refreshing", () => {
  const submit = source.slice(source.indexOf('const submit = useCallback'), source.indexOf('const cancel = useCallback'));
  expect(submit.indexOf('localStorage.setItem(PENDING_KEY')).toBeLessThan(submit.indexOf('await api.submit'));
  expect(submit.indexOf('localStorage.setItem(JOB_KEY')).toBeLessThan(submit.indexOf('await refresh()'));
  expect(submit).toContain('submittingRef.current || localStorage.getItem(PENDING_KEY)');
  expect(source).toContain('useState(() => localStorage.getItem(DRAFT_KEY)');
  expect(source).toContain('busy || submissionPending ||');
});
