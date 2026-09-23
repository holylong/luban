export type TokenKind = "keyword" | "variable" | "function" | "type" | "string" | "number" | "comment" | "operator" | "plain";
export interface CodeToken { text: string; kind: TokenKind }
const keywords = new Set(("const let var val fun function return if else for while class interface type import from export async await new try catch throw throws extends implements def in and or not match fn pub use struct enum true false null undefined None self this package private public protected static final override suspend data object void int boolean switch case break continue default as is when with yield typeof instanceof readonly constructor super").split(" "));

/** Lightweight lexical coloring, not semantic analysis. Every source character is preserved. */
export function codeTokens(source: string): CodeToken[] {
  const pattern = /\/\/[^\n]*|\/\*[\s\S]*?(?:\*\/|$)|#[^\n]*|"(?:\\.|[^"\\])*"?|'(?:\\.|[^'\\])*'?|`(?:\\.|[^`\\])*`?|\b(?:0x[\da-fA-F]+|\d+(?:\.\d+)?)\b|[$\p{L}_][$\p{L}\p{N}_]*|[=+*/!<>?&|:%^-]+|\s+|./gu;
  return Array.from(source.matchAll(pattern), match => {
    const text = match[0];
    let kind: TokenKind = "plain";
    if (/^(\/\/|\/\*|#)/u.test(text)) kind = "comment";
    else if (/^["'`]/u.test(text)) kind = "string";
    else if (/^\d/u.test(text)) kind = "number";
    else if (keywords.has(text)) kind = "keyword";
    else if (/^[$\p{L}_]/u.test(text)) {
      kind = /^\s*\(/u.test(source.slice(match.index! + text.length)) ? "function" : /^[A-Z]/u.test(text) ? "type" : "variable";
    } else if (/^[=+*/!<>?&|:%^-]+$/u.test(text)) kind = "operator";
    return { text, kind };
  });
}
