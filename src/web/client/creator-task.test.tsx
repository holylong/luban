import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { TaskRow, type CreatorTask } from "./creator";

/** A reminder row has to look different from a job row: it never runs a model. */
describe("Creator task row", () => {
  const base: CreatorTask = {
    id: "t1", prompt: "提醒我下班", workspace: "/tmp", at: Date.now(), timeout: 900_000, status: "queued",
  };

  it("marks a reminder with a 提醒 badge", () => {
    const html = renderToStaticMarkup(<TaskRow task={{ ...base, kind: "notify" }} now={Date.now()} onCancel={() => undefined} />);
    expect(html).toContain("提醒</span>");
    expect(html).toContain('class="kind"');
  });

  it("leaves an ordinary job without the badge", () => {
    const html = renderToStaticMarkup(<TaskRow task={{ ...base, kind: "agent" }} now={Date.now()} onCancel={() => undefined} />);
    expect(html).not.toContain('class="kind"');
  });
});
