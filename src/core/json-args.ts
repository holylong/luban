/**
 * Parse a tool call's arguments.
 *
 * Models routinely emit a shell command with a literal newline (or tab) inside
 * a JSON string instead of `\n`, which makes the arguments invalid JSON and the
 * tool fails before it runs — `Bad control character in string literal`. A
 * strict parse is tried first; if it fails, raw control characters inside string
 * literals are escaped and the parse is retried. Nothing else is rewritten, so a
 * genuinely malformed payload still reports an error.
 */
export function parseToolArguments(raw: string): unknown {
  const text = raw.trim() || "{}";
  try {
    return JSON.parse(text);
  } catch (error) {
    const repaired = escapeControlCharsInStrings(text);
    if (repaired === text) throw error;
    return JSON.parse(repaired);
  }
}

/** Escape control characters that sit inside a JSON string, leaving structure alone. */
export function escapeControlCharsInStrings(text: string): string {
  let out = "";
  let inString = false;
  let escaped = false;
  for (const char of text) {
    if (!inString) {
      if (char === '"') inString = true;
      out += char;
      continue;
    }
    if (escaped) { out += char; escaped = false; continue; }
    if (char === "\\") { out += char; escaped = true; continue; }
    if (char === '"') { inString = false; out += char; continue; }
    const code = char.charCodeAt(0);
    if (code >= 0x20) { out += char; continue; }
    out += code === 0x0a ? "\\n" : code === 0x0d ? "\\r" : code === 0x09 ? "\\t"
      : code === 0x08 ? "\\b" : code === 0x0c ? "\\f" : `\\u${code.toString(16).padStart(4, "0")}`;
  }
  return out;
}
