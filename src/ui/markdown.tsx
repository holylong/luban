import React from "react";
import { Box, Text } from "ink";
import { theme } from "./theme.js";
import { codeTokens, type TokenKind } from "./syntax.js";

export type MarkdownBlock =
  | { kind: "paragraph"; content: string }
  | { kind: "heading"; content: string; level: number }
  | { kind: "list"; content: string }
  | { kind: "quote"; content: string }
  | { kind: "code"; content: string; language: string }
  | { kind: "rule"; content: "" };

export function parseMarkdownBlocks(value: string): MarkdownBlock[] {
  const blocks: MarkdownBlock[] = [];
  const paragraph: string[] = [];
  const code: string[] = [];
  let language = "";
  let inCode = false;
  const flushParagraph = () => {
    if (paragraph.length) blocks.push({ kind: "paragraph", content: paragraph.splice(0).join("\n") });
  };
  const flushCode = () => {
    blocks.push({ kind: "code", content: code.splice(0).join("\n"), language });
    language = "";
  };

  for (const line of value.split("\n")) {
    const fence = line.match(/^\s*```\s*([^\s`]*)/u);
    if (fence) {
      if (inCode) flushCode();
      else {
        flushParagraph();
        language = fence[1] ?? "";
      }
      inCode = !inCode;
      continue;
    }
    if (inCode) {
      code.push(line);
      continue;
    }
    if (!line.trim()) {
      flushParagraph();
      continue;
    }
    const heading = line.match(/^(#{1,6})\s+(.+)$/u);
    if (heading) {
      flushParagraph();
      blocks.push({ kind: "heading", content: heading[2]!, level: heading[1]!.length });
      continue;
    }
    const list = line.match(/^\s*[-*+]\s+(.+)$/u);
    if (list) {
      flushParagraph();
      blocks.push({ kind: "list", content: list[1]! });
      continue;
    }
    const quote = line.match(/^\s*>\s?(.*)$/u);
    if (quote) {
      flushParagraph();
      blocks.push({ kind: "quote", content: quote[1]! });
      continue;
    }
    if (/^\s*(?:---+|___+|\*\*\*+)\s*$/u.test(line)) {
      flushParagraph();
      blocks.push({ kind: "rule", content: "" });
      continue;
    }
    paragraph.push(line);
  }
  if (inCode) flushCode();
  flushParagraph();
  return blocks;
}

function InlineText({ value }: { value: string }) {
  const pieces = value.split(/(`[^`]+`|\*\*[^*]+\*\*)/gu);
  return (
    <Text color={theme.text} wrap="wrap">
      {pieces.map((piece, index) => {
        if (piece.startsWith("`") && piece.endsWith("`")) {
          return <Text key={index} color={theme.code}>{piece.slice(1, -1)}</Text>;
        }
        if (piece.startsWith("**") && piece.endsWith("**")) {
          return <Text key={index} color={theme.primary} bold>{piece.slice(2, -2)}</Text>;
        }
        return piece;
      })}
    </Text>
  );
}
const tokenColors: Record<TokenKind, string> = {
  keyword: theme.purple, variable: "#9cdcfe", function: "#ffd580",
  type: "#4ed9c4", string: "#a8dc91", number: "#ffb58a",
  comment: theme.muted, operator: "#ef91c5", plain: theme.text,
};

export function HighlightedCodeLine({ line, backgroundColor }: { line: string; backgroundColor?: string }) {
  return <Text wrap="truncate-end" backgroundColor={backgroundColor}>
    {codeTokens(line).map((token, index) => <Text key={index} color={tokenColors[token.kind]} bold={token.kind === "keyword"}>{token.text}</Text>)}
  </Text>;
}
export function MarkdownView({ content }: { content: string }) {
  return (
    <Box flexDirection="column">
      {parseMarkdownBlocks(content).map((block, index) => {
        if (block.kind === "heading") {
          return <Box key={index} marginTop={index ? 1 : 0}><Text color={theme.primary} bold>{block.content}</Text></Box>;
        }
        if (block.kind === "list") {
          return <Box key={index}><Text color={theme.muted}>• </Text><InlineText value={block.content} /></Box>;
        }
        if (block.kind === "quote") {
          return <Box key={index}><Text color={theme.dim}>┃ </Text><Text color={theme.muted}>{block.content}</Text></Box>;
        }
        if (block.kind === "rule") {
          return <Text key={index} color={theme.dim}>────────────────────────</Text>;
        }
        if (block.kind === "code") {
          return (
            <Box key={index} flexDirection="column" backgroundColor={theme.codeBackground} paddingX={1} marginY={1}>
              <Box justifyContent="space-between">
                <Text color={theme.accent} bold>{block.language || "code"}</Text>
                <Text color={theme.dim}>CODE</Text>
              </Box>
              {block.content.split("\n").map((line, lineIndex) => <HighlightedCodeLine key={lineIndex} line={line} />)}
            </Box>
          );
        }
        return <Box key={index} marginTop={index ? 1 : 0}><InlineText value={block.content} /></Box>;
      })}
    </Box>
  );
}
