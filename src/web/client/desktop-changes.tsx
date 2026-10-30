import React from "react";
import { EditRecord } from "./tool-card";
import type { SessionDetail, TimelineItem } from "./types";

export function collectDesktopEdits(session: SessionDetail | undefined, timeline: TimelineItem[]) {
  const edits = new Map((session?.edits ?? []).map(edit => [edit.id, edit]));
  for (const item of timeline) {
    if (item.kind === "tool" && item.run.editPreview) edits.set(item.run.callId, { id: item.run.callId, name: item.run.name, preview: item.run.editPreview });
  }
  return [...edits.values()];
}

/** Only the latest live edit belongs in the center; history stays in Agent. */
export function currentDesktopEdit(timeline: TimelineItem[]) {
  return collectDesktopEdits(undefined, timeline).at(-1);
}

/** Execution diffs are read-only, independent of dirty editor buffers. */
export function DesktopChanges({ timeline }: { timeline: TimelineItem[] }): React.ReactElement | null {
  const edit = currentDesktopEdit(timeline);
  if (!edit) return null;
  return <section className="desktop-changes">
    <div className="desktop-changes-heading">当前代码修改（只读对比，不覆盖编辑器未保存内容；完整记录见 Agent）</div>
    <EditRecord key={edit.id} preview={edit.preview} />
  </section>;
}
