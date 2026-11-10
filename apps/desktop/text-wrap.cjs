// No font metrics are available in the main process, so preview wrapping uses
// nominal advances: a CJK glyph is one em, Latin is a little over half, a space
// is narrow. It only needs to keep text inside its shape, not justify it.

const WIDE = /[\u1100-\u115f\u2e80-\u303f\u3040-\u9fff\uac00-\ud7a3\uf900-\ufaff\ufe30-\ufe4f\uff00-\uff60\uffe0-\uffe6]/;

function advanceOf(char, size) {
  if (WIDE.test(char)) return size;
  if (char === " ") return size * 0.3;
  return size * 0.55;
}

function measure(text, size) {
  let total = 0;
  for (const char of text) total += advanceOf(char, size);
  return total;
}

/** Greedy wrap on spaces, falling back to a hard break so a long word still fits. */
function wrapText(text, size, maxWidth) {
  const source = String(text ?? "");
  if (!(size > 0)) return source ? [source] : [];
  const limit = Number.isFinite(maxWidth) && maxWidth > 0 ? maxWidth : Infinity;
  const lines = [];
  for (const paragraph of source.split("\n")) {
    if (!paragraph) { lines.push(""); continue; }
    let line = "";
    let width = 0;
    let space = -1;
    for (const char of paragraph) {
      const advance = advanceOf(char, size);
      if (line && width + advance > limit) {
        const cut = space > 0 ? space : line.length;
        lines.push(line.slice(0, cut).trimEnd());
        line = line.slice(cut).trimStart();
        width = measure(line, size);
        space = line.lastIndexOf(" ");
        if (!line && char === " ") continue;
      }
      line += char;
      width += advance;
      if (char === " ") space = line.length - 1;
    }
    lines.push(line.trimEnd());
  }
  return lines;
}

module.exports = { wrapText, measure };
