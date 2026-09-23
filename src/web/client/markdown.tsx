import React from "react";

/* A compact code tokenizer. Dependency-free on purpose: the bundle ships
   inside the npm package and the package runtime has no frontend deps. */
const KEYWORDS = new Set(("abstract|as|async|await|break|case|catch|class|const|continue|debugger|default|delete|do|else|enum|export|extends|false|finally|for|from|function|get|if|implements|import|in|instanceof|interface|let|new|null|of|package|private|protected|public|readonly|return|satisfies|set|static|super|switch|this|throw|true|try|type|typeof|undefined|var|void|while|with|yield|def|elif|except|lambda|None|True|False|raise|pass|and|or|not|is|end|then|fi|done|local|echo|fn|impl|match|mut|pub|struct|trait|use|where|loop|unsafe|mod|crate|select|insert|update|delete_from|go|defer|chan|package|func|range|map|nil|extern|register|typedef|sizeof|union|volatile|goto|signed|unsigned|short|long|float|double|char|int|bool|string|lambda|print|return|import|from").split("|"));

const LINE_COMMENT: Record<string, string> = {
  ts: "//", tsx: "//", js: "//", jsx: "//", mjs: "//", cjs: "//", json: "", java: "//", c: "//", h: "//",
  cpp: "//", cc: "//", hpp: "//", cs: "//", go: "//", rust: "//", rs: "//", swift: "//", kt: "//",
  py: "#", python: "#", sh: "#", bash: "#", zsh: "#", yaml: "#", yml: "#", toml: "#", rb: "#", ruby: "#",
  conf: "#", ini: "#", dockerfile: "#", makefile: "#", r: "#", pl: "#", sql: "--", lua: "--", vim: "--",
};

export interface Token { kind: "plain" | "key" | "str" | "num" | "com" | "type"; text: string }

const CLASS_NAMES: Record<Token["kind"], string> = {
  plain: "", key: "tok-key", str: "tok-str", num: "tok-num", com: "tok-com", type: "tok-type",
};

/**
 * Tokenize one line of code. Intentionally lightweight: it recognizes the
 * shapes that dominate real source (comments, strings, numbers, keywords,
 * capitalized type names) without pretending to be a language parser.
 */
export function tokenize(line: string, language = ""): Token[] {
  const comment = LINE_COMMENT[language] ?? (language ? "//" : "//");
  const tokens: Token[] = [];
  let index = 0;
  const push = (kind: Token["kind"], text: string): void => {
    if (!text) return;
    const last = tokens.at(-1);
    if (last && last.kind === kind) last.text += text;
    else tokens.push({ kind, text });
  };
  while (index < line.length) {
    const char = line[index]!;
    const rest = line.slice(index);
    if (comment && rest.startsWith(comment)) { push("com", rest); break; }
    if (rest.startsWith("/*")) {
      const end = line.indexOf("*/", index + 2);
      if (end < 0) { push("com", rest); break; }
      push("com", line.slice(index, end + 2));
      index = end + 2;
      continue;
    }
    if (char === '"' || char === "'" || char === "`") {
      let cursor = index + 1;
      while (cursor < line.length) {
        if (line[cursor] === "\\") { cursor += 2; continue; }
        if (line[cursor] === char) { cursor += 1; break; }
        cursor += 1;
      }
      push("str", line.slice(index, cursor));
      index = cursor;
      continue;
    }
    if (/[0-9]/u.test(char) && !/[\w$]/u.test(line[index - 1] ?? "")) {
      const match = /^[0-9][0-9a-fA-F_xXob.]*/u.exec(rest)!;
      push("num", match[0]);
      index += match[0].length;
      continue;
    }
    const word = /^[A-Za-z_$][\w$]*/u.exec(rest);
    if (word) {
      const text = word[0];
      if (KEYWORDS.has(text)) push("key", text);
      else if (/^[A-Z]/u.test(text)) push("type", text);
      else push("plain", text);
      index += text.length;
      continue;
    }
    push("plain", char);
    index += 1;
  }
  return tokens;
}

export function HighlightedLine({ line, language }: { line: string; language?: string }): React.ReactElement {
  if (!line) return <>{""}</>;
  const tokens = tokenize(line, language);
  return <>{tokens.map((token, index) => token.kind === "plain"
    ? <React.Fragment key={index}>{token.text}</React.Fragment>
    : <span key={index} className={CLASS_NAMES[token.kind]}>{token.text}</span>)}</>;
}

/* Markdown ------------------------------------------------------------- */

function inline(text: string, keyPrefix: string): React.ReactNode[] {
  const nodes: React.ReactNode[] = [];
  // Inline code first so its contents are never re-interpreted as emphasis.
  const pattern = /(`[^`]+`)|(\*\*[^*]+\*\*)|(\*[^*\n]+\*)|(\[[^\]\n]+\]\([^)\s]+\))|(~~[^~]+~~)/gu;
  let last = 0;
  let match: RegExpExecArray | null;
  let index = 0;
  while ((match = pattern.exec(text))) {
    if (match.index > last) nodes.push(text.slice(last, match.index));
    const token = match[0];
    const key = `${keyPrefix}-i${index++}`;
    if (token.startsWith("`")) nodes.push(<code key={key} className="inline">{token.slice(1, -1)}</code>);
    else if (token.startsWith("**")) nodes.push(<strong key={key}>{token.slice(2, -2)}</strong>);
    else if (token.startsWith("~~")) nodes.push(<del key={key}>{token.slice(2, -2)}</del>);
    else if (token.startsWith("*")) nodes.push(<em key={key}>{token.slice(1, -1)}</em>);
    else {
      const link = /^\[([^\]]+)\]\(([^)\s]+)\)$/u.exec(token);
      if (link) nodes.push(<a key={key} href={link[2]} target="_blank" rel="noreferrer noopener">{link[1]}</a>);
      else nodes.push(token);
    }
    last = match.index + token.length;
  }
  if (last < text.length) nodes.push(text.slice(last));
  return nodes;
}

function codeBlock(code: string, language: string, key: string): React.ReactElement {
  const lines = code.replace(/\n$/u, "").split("\n");
  return (
    <pre key={key} className="codeblock">
      <code>
        {lines.map((line, index) => (
          <React.Fragment key={index}>
            <HighlightedLine line={line} language={language} />
            {index < lines.length - 1 ? "\n" : null}
          </React.Fragment>
        ))}
      </code>
    </pre>
  );
}

/**
 * Render a bounded subset of Markdown as React elements.
 *
 * Everything is escaped by construction: no `dangerouslySetInnerHTML` is used,
 * so untrusted model or file content can never inject markup.
 */
export function Markdown({ text }: { text: string }): React.ReactElement {
  const lines = (text ?? "").replaceAll("\r\n", "\n").split("\n");
  const blocks: React.ReactNode[] = [];
  let index = 0;
  let key = 0;

  while (index < lines.length) {
    const line = lines[index]!;

    const fence = /^\s*```\s*([\w+-]*)\s*$/u.exec(line);
    if (fence) {
      const language = fence[1] ?? "";
      const body: string[] = [];
      index += 1;
      while (index < lines.length && !/^\s*```\s*$/u.test(lines[index]!)) { body.push(lines[index]!); index += 1; }
      index += 1;
      blocks.push(codeBlock(body.join("\n"), language, `b${key++}`));
      continue;
    }

    if (!line.trim()) { index += 1; continue; }

    const heading = /^(#{1,6})\s+(.*)$/u.exec(line);
    if (heading) {
      const level = Math.min(4, heading[1]!.length);
      const Tag = `h${level}` as "h1" | "h2" | "h3" | "h4";
      blocks.push(<Tag key={`b${key++}`}>{inline(heading[2] ?? "", `h${key}`)}</Tag>);
      index += 1;
      continue;
    }

    if (/^\s*(?:-{3,}|\*{3,}|_{3,})\s*$/u.test(line)) { blocks.push(<hr key={`b${key++}`} />); index += 1; continue; }

    if (/^\s*>\s?/u.test(line)) {
      const quote: string[] = [];
      while (index < lines.length && /^\s*>\s?/u.test(lines[index]!)) { quote.push(lines[index]!.replace(/^\s*>\s?/u, "")); index += 1; }
      blocks.push(<blockquote key={`b${key++}`}>{inline(quote.join(" "), `q${key}`)}</blockquote>);
      continue;
    }

    if (/^\s*\|.*\|\s*$/u.test(line) && /^\s*\|[\s:|-]+\|\s*$/u.test(lines[index + 1] ?? "")) {
      const header = line.trim().replace(/^\||\|$/gu, "").split("|").map(cell => cell.trim());
      index += 2;
      const rows: string[][] = [];
      while (index < lines.length && /^\s*\|.*\|\s*$/u.test(lines[index]!)) {
        rows.push(lines[index]!.trim().replace(/^\||\|$/gu, "").split("|").map(cell => cell.trim()));
        index += 1;
      }
      blocks.push(
        <table key={`b${key++}`}>
          <thead><tr>{header.map((cell, i) => <th key={i}>{inline(cell, `th${i}`)}</th>)}</tr></thead>
          <tbody>{rows.map((row, rowIndex) => <tr key={rowIndex}>{row.map((cell, i) => <td key={i}>{inline(cell, `td${rowIndex}-${i}`)}</td>)}</tr>)}</tbody>
        </table>,
      );
      continue;
    }

    const list = /^\s*([-*+]|\d+[.)])\s+/u.exec(line);
    if (list) {
      const ordered = /\d/u.test(list[1]!);
      const items: string[] = [];
      while (index < lines.length) {
        const item = /^\s*(?:[-*+]|\d+[.)])\s+(.*)$/u.exec(lines[index]!);
        if (!item) {
          // A lazily continued paragraph inside the current list item.
          if (items.length && lines[index]!.trim() && /^\s{2,}\S/u.test(lines[index]!)) { items[items.length - 1] += ` ${lines[index]!.trim()}`; index += 1; continue; }
          break;
        }
        items.push(item[1] ?? "");
        index += 1;
      }
      const Tag = ordered ? "ol" : "ul";
      blocks.push(<Tag key={`b${key++}`}>{items.map((item, i) => <li key={i}>{inline(item, `li${key}-${i}`)}</li>)}</Tag>);
      continue;
    }

    const paragraph: string[] = [];
    while (index < lines.length && lines[index]!.trim() && !/^\s*(```|#{1,6}\s|>|[-*+]\s|\d+[.)]\s|\|)/u.test(lines[index]!)) {
      paragraph.push(lines[index]!);
      index += 1;
    }
    if (paragraph.length) blocks.push(<p key={`b${key++}`}>{inline(paragraph.join(" "), `p${key}`)}</p>);
    else { blocks.push(<p key={`b${key++}`}>{inline(line, `p${key}`)}</p>); index += 1; }
  }

  return <div className="md">{blocks}</div>;
}
