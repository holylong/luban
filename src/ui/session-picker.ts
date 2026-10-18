import type { SessionRecord } from "../core/types.js";

/** Picker visibility is separate from storage: command history alone is not a conversation. */
export function sessionChoices(records: SessionRecord[], currentId: string, query = ""): SessionRecord[] {
  const needle = query.trim().toLowerCase();
  return records.filter(record => {
    if (record.id === currentId) return false;
    const conversation = Array.isArray(record.messages) && record.messages.some(message => message.role !== "system"
      && (message.content?.trim() || message.images?.length || message.tool_calls?.length || message.editPreview?.trim()));
    const pending = record.pendingInputs?.some(input => input.content.trim() || input.images?.length);
    const edits = record.edits?.some(edit => edit.preview.trim());
    if (!conversation && !pending && !edits) return false;
    const date = record.updatedAt.slice(0, 16).replace("T", " ");
    return !needle || `${record.title} ${record.project} ${date}`.toLowerCase().includes(needle);
  });
}
