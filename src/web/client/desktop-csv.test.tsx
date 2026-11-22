import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { expect, it } from "vitest";
import { readFileSync } from "node:fs";
import {
  csvPreviewAction, columnLabel, gridSummary, isNumericCell, isTablePath, parseDelimited, sniffDelimiter, splitRecords,
} from "./desktop-csv";
import { CsvDocument } from "./desktop-csv-view";

it("offers the table preview only for delimited files", () => {
  expect(isTablePath("data/users.csv")).toBe(true);
  expect(isTablePath("/work/EXPORT.TSV")).toBe(true);
  expect(isTablePath("notes.tab")).toBe(true);
  expect(isTablePath("data/users.csv.bak")).toBe(false);
  expect(isTablePath("src/app.ts")).toBe(false);
  expect(isTablePath("csv")).toBe(false);
  expect(isTablePath("")).toBe(false);
});

it("labels the toggle with the mode it switches to", () => {
  expect(csvPreviewAction("src/app.ts", false)).toBeNull();
  expect(csvPreviewAction("users.csv", false)).toMatchObject({ label: "表格预览", pressed: false });
  expect(csvPreviewAction("users.csv", true)).toMatchObject({ label: "编辑", pressed: true });
  expect(csvPreviewAction("users.csv", false).title).toContain("⌘/Ctrl+Shift+V");
});

it("treats a whole-cell number as numeric and nothing else", () => {
  for (const value of ["12", "-3.5", "+7", ".5", "1e6", "1,234.50"]) expect(isNumericCell(value), value).toBe(true);
  for (const value of ["", "  ", "12abc", "1 2", "2026-01-01", "007a", "N/A"]) expect(isNumericCell(value), value).toBe(false);
});

it("sniffs the separator from the first line, ignoring quoted commas", () => {
  expect(sniffDelimiter("a,b\n1,2")).toBe(",");
  expect(sniffDelimiter("a\tb\n1\t2")).toBe("\t");
  expect(sniffDelimiter("a;b;c\n1;2;3")).toBe(";");
  expect(sniffDelimiter("a|b\n1|2")).toBe("|");
  // One tab and one comma tie on count; the extension-flavoured candidate wins.
  expect(sniffDelimiter("a\tb,c")).toBe("\t");
  // A quoted comma is inside a field: this is a single-column file.
  expect(sniffDelimiter('"Smith, John"\n"Doe, Jane"')).toBe(",");
  expect(sniffDelimiter("")).toBe(",");
});

it("parses quotes, escaped quotes, embedded newlines and CRLF", () => {
  expect(splitRecords('a,"b,c",d', ",")).toEqual([["a", "b,c", "d"]]);
  expect(splitRecords('a,"say ""hi""",c', ",")).toEqual([["a", 'say "hi"', "c"]]);
  expect(splitRecords('a,"line1\nline2",c', ",")).toEqual([["a", "line1\nline2", "c"]]);
  expect(splitRecords("a,b\r\n1,2\r\n", ",")).toEqual([["a", "b"], ["1", "2"]]);
  expect(splitRecords("a,b\n1,2\n", ",")).toEqual([["a", "b"], ["1", "2"]]);
  // A quote in the middle of an unquoted field is a literal character, not the
  // start of a quoted run that would swallow the rest of the file.
  expect(splitRecords('a"b,c\n1,2', ",")).toEqual([['a"b', "c"], ["1", "2"]]);
});

it("reads a header row only when the first row is complete text", () => {
  const withHeader = parseDelimited("name,city\nAda,London\nBob,Paris")!;
  expect(withHeader.header).toEqual(["name", "city"]);
  expect(withHeader.rows.map(row => row.index)).toEqual([2, 3]);
  expect(withHeader.rows[0]!.cells[0]).toEqual({ text: "Ada", numeric: false });

  // A first row of numbers is data, so it is rendered with the rest.
  const noHeader = parseDelimited("1,2\n3,4")!;
  expect(noHeader.header).toEqual(["A", "B"]);
  expect(noHeader.rows.map(row => row.index)).toEqual([1, 2]);

  // A single row has nothing to compare against: no header guess.
  expect(parseDelimited("1,2,3")!.header).toEqual(["A", "B", "C"]);
});

it("pads ragged rows and keeps numbers right-aligned", () => {
  const grid = parseDelimited("a,b,c\n1,2\n3,4,5,6")!;
  expect(grid.columns).toBe(4);
  expect(grid.rows[0]!.cells.map(cell => cell.text)).toEqual(["1", "2", "", ""]);
  expect(grid.rows[0]!.cells[0]!.numeric).toBe(true);
  expect(grid.rows[0]!.cells[2]!.numeric).toBe(false);
  expect(grid.truncatedColumns).toBe(0);
});

it("caps what it renders and counts what it withheld", () => {
  const rows = Array.from({ length: 30 }, (_, index) => `row${index},${index}`).join("\n");
  const grid = parseDelimited(`key,value\n${rows}`, { maxRows: 10, maxColumns: 1 })!;
  expect(grid.rows).toHaveLength(10);
  expect(grid.totalRows).toBe(30);
  expect(grid.truncatedRows).toBe(20);
  expect(grid.columns).toBe(1);
  expect(grid.truncatedColumns).toBe(1);
  const summary = gridSummary(grid);
  expect(summary).toContain("逗号分隔");
  expect(summary).toContain("另有 20 行未显示");
  expect(summary).toContain("另有 1 列未显示");
});

it("strips a BOM, keeps a tab-separated file tab-separated, and finds nothing in an empty buffer", () => {
  const grid = parseDelimited("\ufeffid\tname\n1\tluban")!;
  expect(grid.delimiter).toBe("\t");
  expect(grid.header).toEqual(["id", "name"]);
  expect(gridSummary(grid)).toContain("Tab 分隔");
  expect(parseDelimited("")).toBeNull();
  expect(parseDelimited("  \n\n")).toBeNull();
});

it("names header-less columns like a spreadsheet", () => {
  expect(columnLabel(0)).toBe("A");
  expect(columnLabel(25)).toBe("Z");
  expect(columnLabel(26)).toBe("AA");
});

it("renders the live buffer as a table and marks numbers", () => {
  const html = renderToStaticMarkup(<CsvDocument path="users.csv" content={"id,name\n1,Ada\n2,Bob"} />);
  expect(html).toContain('class="desktop-csv"');
  expect(html).toContain('aria-label="预览 users.csv"');
  expect(html).toContain("<th scope=\"col\">id</th>");
  expect(html).toContain("<th scope=\"col\">name</th>");
  expect(html).toContain('<td class="num">1</td>');
  expect(html).toContain('<td class="">Ada</td>');
  expect(html).toContain("逗号分隔 · 2 列 · 2 行");
});

it("says the table is empty instead of rendering a blank grid", () => {
  const html = renderToStaticMarkup(<CsvDocument path="empty.csv" content={" \n"} />);
  expect(html).toContain("desktop-csv-empty");
  expect(html).toContain("这个文件还是空的");
});

it("styles the table so the header and row numbers stay put", () => {
  const css = readFileSync(new URL("./desktop.css", import.meta.url), "utf8");
  expect(css).toMatch(/\.desktop-csv-scroll\s*\{[^}]*overflow: auto/);
  expect(css).toMatch(/\.desktop-csv-table thead th\s*\{[^}]*position: sticky/);
  expect(css).toMatch(/\.desktop-csv-table tbody th\s*\{[^}]*position: sticky/);
  expect(css).toMatch(/\.desktop-csv-table td\.num\s*\{[^}]*text-align: right/);
  expect(css).toMatch(/\.desktop-csv-table th\.corner\s*\{[^}]*position: sticky/);
});
