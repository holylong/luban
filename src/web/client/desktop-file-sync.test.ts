import { afterEach, expect, it, vi } from "vitest";
import { acceptDisk, type DesktopFile, type EditorDocument } from "./desktop-bridge";
import { startFileSync } from "./desktop-file-sync";

const original: EditorDocument = { path: "a.ts", content: "old", saved: "old", revision: "r1" };
const disk: DesktopFile = { path: "a.ts", content: "external", revision: "r2" };
afterEach(() => vi.useRealTimers());

it("reloads clean buffers but preserves drafts and the original save revision on conflict", () => {
  expect(acceptDisk(original, disk)).toEqual({ ...disk, saved: disk.content });
  const draft = { ...original, content: "local" };
  expect(acceptDisk(draft, disk)).toEqual({ ...draft, conflict: true, diskError: undefined });
  expect(acceptDisk({ ...draft, content: disk.content }, disk)).toEqual({ ...disk, saved: disk.content });
  expect(acceptDisk({ ...draft, conflict: true }, original).conflict).toBe(false);
});

function harness(readFile = vi.fn<(path: string) => Promise<DesktopFile>>(async () => disk)) {
  vi.useFakeTimers();
  let documents = [original];
  let saving = false;
  const target = new EventTarget();
  const stop = startFileSync({ readFile, documents: () => documents, saving: () => saving,
    update: change => { documents = change(documents); }, target });
  return { readFile, stop, target, get: () => documents,
    set: (next: EditorDocument[]) => { documents = next; }, saving: (next: boolean) => { saving = next; } };
}

it("polls all open tabs, refreshes on focus, and stops after cleanup", async () => {
  const ui = harness(vi.fn(async path => ({ ...disk, path })));
  await vi.advanceTimersByTimeAsync(0);
  expect(ui.get()[0].content).toBe("external");
  ui.set([original, { ...original, path: "b.ts" }]);
  await vi.advanceTimersByTimeAsync(1000);
  expect(ui.get().map(item => item.content)).toEqual(["external", "external"]);
  ui.set([original]);
  ui.target.dispatchEvent(new Event("focus"));
  await vi.advanceTimersByTimeAsync(0);
  expect(ui.get()[0].revision).toBe("r2");
  ui.stop();
  const calls = ui.readFile.mock.calls.length;
  await vi.advanceTimersByTimeAsync(2000);
  ui.target.dispatchEvent(new Event("focus"));
  expect(ui.readFile).toHaveBeenCalledTimes(calls);
});

it("reconciles typing during a read and does not apply an old read after a save", async () => {
  let resolve!: (file: DesktopFile) => void;
  const ui = harness(vi.fn(() => new Promise<DesktopFile>(done => { resolve = done; })));
  ui.set([{ ...original, content: "typed during read" }]);
  resolve(disk);
  await vi.advanceTimersByTimeAsync(0);
  expect(ui.get()[0]).toMatchObject({ content: "typed during read", revision: "r1", conflict: true });
  await vi.advanceTimersByTimeAsync(1000);
  const saved = { ...original, content: "saved", saved: "saved", revision: "r3" };
  ui.set([saved]);
  resolve(disk);
  await vi.advanceTimersByTimeAsync(0);
  expect(ui.get()).toEqual([saved]);
  ui.stop();
});

it("preserves missing-file buffers, recovers when restored, and pauses during saves", async () => {
  const read = vi.fn(async () => disk);
  read.mockRejectedValueOnce(new Error("ENOENT"));
  const ui = harness(read);
  await vi.advanceTimersByTimeAsync(0);
  expect(ui.get()[0]).toMatchObject({ content: "old", diskError: "Error: ENOENT" });
  ui.saving(true);
  await vi.advanceTimersByTimeAsync(1000);
  expect(read).toHaveBeenCalledTimes(1);
  ui.saving(false);
  await vi.advanceTimersByTimeAsync(1000);
  expect(ui.get()).toEqual([{ ...disk, saved: disk.content }]);
  ui.stop();
});

it("ignores a pending read after unmount or tab close", async () => {
  let resolve!: (file: DesktopFile) => void;
  const ui = harness(vi.fn(() => new Promise<DesktopFile>(done => { resolve = done; })));
  ui.set([]);
  resolve(disk);
  await vi.advanceTimersByTimeAsync(0);
  expect(ui.get()).toEqual([]);
  ui.set([original]);
  await vi.advanceTimersByTimeAsync(1000);
  ui.stop();
  resolve(disk);
  await vi.advanceTimersByTimeAsync(0);
  expect(ui.get()).toEqual([original]);
});
