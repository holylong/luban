import { expect, it } from "vitest";
import { followEdit, type EditView } from "./desktop-edit-view";

it.each(["done", "failed", "cancelled", "paused"] as const)("restores the original code view after %s without losing editor state", status => {
  let view: EditView = { tab: "code" };
  view = followEdit(view, "j1", "working", "edit1");
  expect(view.tab).toBe("changes");
  view = followEdit(view, "j1", "working", "edit2");
  expect(followEdit(view, "j1", status, "edit2")).toMatchObject({ tab: "code", automatic: undefined });
});
it("does not reopen previews for completed history", () => {
  expect(followEdit({ tab: "code" }, "j1", "done", "edit1").tab).toBe("code");
});
it("restores on switching jobs or clearing the selection", () => {
  const view = followEdit({ tab: "code" }, "j1", "working", "edit1");
  expect(followEdit(view, "j2", "working").tab).toBe("code");
  expect(followEdit(view, "", undefined).tab).toBe("code");
});
it("keeps a manually selected changes tab open at completion", () => {
  const automatic = followEdit({ tab: "code" }, "j1", "working", "edit1");
  const manual: EditView = { tab: "changes", seen: automatic.seen };
  expect(followEdit(manual, "j1", "done", "edit1").tab).toBe("changes");
  expect(followEdit(manual, "j1", "working", "edit1").automatic).toBeUndefined();
});
it("restores changes when that was the user's original view", () => {
  const view = followEdit({ tab: "changes" }, "j1", "working", "edit1");
  expect(followEdit(view, "j1", "done", "edit1").tab).toBe("changes");
});
