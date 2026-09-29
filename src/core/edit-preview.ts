/** A bounded, line-numbered record of an actual file mutation, not a Git HEAD diff. */
export function editPreview(path: string, before: string, after: string): string {
  const lines = (text: string) => text ? text.replace(/\n$/u, "").split("\n") : [];
  const a = lines(before), b = lines(after);
  type Row = { kind: string; text: string; line: number };
  const rows: Row[] = [];
  let i = 0, j = 0;
  // Bound memory for generated or very large files. The fallback still shows
  // true before/after lines, but may group an entire changed region together.
  let prefix = 0;
  while (prefix < a.length && prefix < b.length && a[prefix] === b[prefix]) prefix++;
  let suffix = 0;
  while (suffix < a.length - prefix && suffix < b.length - prefix && a[a.length - 1 - suffix] === b[b.length - 1 - suffix]) suffix++;
  const n = a.length - prefix - suffix, m = b.length - prefix - suffix;
  for (; i < prefix; i++, j++) rows.push({ kind: " ", text: a[i]!, line: j + 1 });
  if ((n + 1) * (m + 1) <= 1_000_000) {
    const table = Array.from({ length: n + 1 }, () => new Uint32Array(m + 1));
    for (let x = n - 1; x >= 0; x--) for (let y = m - 1; y >= 0; y--) {
      table[x]![y] = a[prefix + x] === b[prefix + y] ? table[x + 1]![y + 1]! + 1 : Math.max(table[x + 1]![y]!, table[x]![y + 1]!);
    }
    while (i < prefix + n || j < prefix + m) {
      if (i < prefix + n && j < prefix + m && a[i] === b[j]) { rows.push({ kind: " ", text: a[i++]!, line: ++j }); }
      else if (i < prefix + n && (j === prefix + m || table[i - prefix + 1]![j - prefix]! >= table[i - prefix]![j - prefix + 1]!)) rows.push({ kind: "-", text: a[i]!, line: ++i });
      else { rows.push({ kind: "+", text: b[j]!, line: ++j }); }
    }
  } else {
    while (i < prefix + n) rows.push({ kind: "-", text: a[i]!, line: ++i });
    while (j < prefix + m) rows.push({ kind: "+", text: b[j]!, line: ++j });
  }
  while (i < a.length) rows.push({ kind: " ", text: a[i++]!, line: ++j });
  const added = rows.filter(row => row.kind === "+").length, removed = rows.filter(row => row.kind === "-").length;
  const visible = new Set<number>();
  rows.forEach((row, index) => { if (row.kind !== " ") for (let k = Math.max(0, index - 2); k <= Math.min(rows.length - 1, index + 2); k++) visible.add(k); });
  const result = [`Edited ${path} (+${added} -${removed})`];
  let last = -1, count = 0;
  for (const index of [...visible].sort((x, y) => x - y)) {
    if (count++ >= 160) { result.push("    … remaining changes omitted from preview"); break; }
    if (last >= 0 && index > last + 1) result.push("    ⋮");
    const row = rows[index]!;
    result.push(`${String(row.line).padStart(6)} ${row.kind}${row.text.slice(0, 300)}${row.text.length > 300 ? "…" : ""}`);
    last = index;
  }
  if (before === after) result.push("    (no content change)");
  else if (!added && !removed) result.push("    (end-of-file newline changed)");
  return result.join("\n");
}

/* ---------------------------------------------------------------------------
 * Reading a record back
 *
 * The parser lives here, next to the writer, so the terminal, the browser
 * workbench and the session exporter all describe one edit identically instead
 * of each maintaining its own copy of the format.
 * ------------------------------------------------------------------------- */

export interface EditRecordRow {
  kind: "header" | "context" | "add" | "remove" | "meta";
  /** Source line number for diff rows; unset on the header and trailer notes. */
  line?: number;
  /** Total changed lines, only on the header row. */
  changes?: number;
  text: string;
  /** Original line for a header or trailer note, so a renderer can echo it verbatim. */
  raw?: string;
}

export interface EditRecordStats {
  path: string;
  added: number;
  removed: number;
  firstLine?: number;
  lastLine?: number;
}

/**
 * Parse an inline edit record.
 *
 * Format: a header (`Edited <path> (+A -R)`), then rows shaped
 * `   123 +text` / `   123 -text` / `   123  text`, separators (`⋮`) and
 * trailer notes. Text is returned verbatim; callers that need to bound the
 * display apply their own truncation, so an export is never silently clipped.
 */
export function parseEditRecord(preview: string): EditRecordRow[] {
  const rows: EditRecordRow[] = [];
  for (const raw of preview.split("\n")) {
    if (!raw.trim()) continue;
    const header = /^Edited (.*) \(\+(\d+) -(\d+)\)$/u.exec(raw);
    if (header) {
      rows.push({ kind: "header", text: header[1] || "", changes: Number(header[2]) + Number(header[3]), raw });
      continue;
    }
    if (/^\s*⋮\s*$/u.test(raw)) { rows.push({ kind: "meta", text: "⋮" }); continue; }
    const numbered = /^(\s*\d+) ([ +\-])(.*)$/u.exec(raw);
    if (numbered) {
      const sign = numbered[2];
      rows.push({
        kind: sign === "+" ? "add" : sign === "-" ? "remove" : "context",
        line: Number(numbered[1]!.trim()),
        text: numbered[3] ?? "",
      });
      continue;
    }
    rows.push({ kind: "meta", text: raw.trim() });
  }
  return rows;
}

export function editRecordStats(rows: EditRecordRow[]): EditRecordStats {
  const header = rows.find(row => row.kind === "header");
  const numbers = rows.map(row => row.line).filter((line): line is number => typeof line === "number");
  return {
    path: header?.text ?? "",
    added: rows.filter(row => row.kind === "add").length,
    removed: rows.filter(row => row.kind === "remove").length,
    ...(numbers.length ? { firstLine: Math.min(...numbers), lastLine: Math.max(...numbers) } : {}),
  };
}

/** Header text for one record, e.g. `` `src/app.ts` (+2 −1) · L4–L6 ``. */
export function editRecordTitle(path: string, stats: EditRecordStats): string {
  const range = stats.firstLine === undefined
    ? ""
    : stats.firstLine === stats.lastLine ? ` · L${stats.firstLine}` : ` · L${stats.firstLine}–L${stats.lastLine}`;
  return `\`${path || "unknown file"}\` (+${stats.added} −${stats.removed})${range}`;
}

/* ---------------------------------------------------------------------------
 * Side-by-side view
 *
 * A unified record lists deletions and additions as separate rows, so a reader
 * has to scan down to pair an old line with its replacement. These helpers turn
 * the same rows into aligned left/right cells — removed text on the left, added
 * text on the right — which is what the terminal and the browser render.
 * ------------------------------------------------------------------------- */

/** One cell of a side-by-side row. `empty` pads the shorter side of a change. */
export interface EditCell {
  kind: "context" | "add" | "remove" | "empty";
  /** Source line number; unset for a padding cell. */
  line?: number;
  text: string;
}

export type EditDisplayRow =
  | { kind: "header"; text: string }
  | { kind: "pair"; left: EditCell; right: EditCell }
  | { kind: "meta"; text: string };

/**
 * Pair a parsed record into side-by-side rows.
 *
 * Runs of removals are matched with the additions that follow, position by
 * position; a change with more deletions than insertions leaves the extra
 * deletions on the left with an empty right cell. Context lines appear on both
 * sides, and each record header stays a full-width row.
 */
export function editDisplayRows(rows: EditRecordRow[]): EditDisplayRow[] {
  const out: EditDisplayRow[] = [];
  const pending: EditCell[] = [];
  const flush = (): void => {
    while (pending.length) out.push({ kind: "pair", left: pending.shift()!, right: { kind: "empty", text: "" } });
  };
  for (const row of rows) {
    if (row.kind === "header") { flush(); out.push({ kind: "header", text: row.raw ?? `Edited ${row.text}` }); continue; }
    if (row.kind === "meta") { flush(); out.push({ kind: "meta", text: row.text }); continue; }
    if (row.kind === "remove") { pending.push({ kind: "remove", line: row.line, text: row.text }); continue; }
    if (row.kind === "add") {
      const left = pending.shift() ?? { kind: "empty" as const, text: "" };
      out.push({ kind: "pair", left, right: { kind: "add", line: row.line, text: row.text } });
      continue;
    }
    flush();
    const cell: EditCell = { kind: "context", line: row.line, text: row.text };
    out.push({ kind: "pair", left: cell, right: { ...cell } });
  }
  flush();
  return out;
}

/** One-line text for a side-by-side row, used where only text can be shown. */
export function editPairText(left: EditCell, right: EditCell): string {
  if (left.kind === "context") return `  ${left.text}`;
  if (left.kind === "empty") return `+ ${right.text}`;
  if (right.kind === "empty") return `- ${left.text}`;
  return `- ${left.text}  + ${right.text}`;
}
