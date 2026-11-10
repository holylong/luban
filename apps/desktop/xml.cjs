// Preview formats (OOXML, draw.io) are XML. A full parser is unnecessary: the
// preview only needs elements, attributes and the text inside a:t / mxCell, so
// this tokenizer keeps namespaces verbatim and tolerates malformed closes.

const ENTITIES = new Map([
  ["amp", "&"], ["lt", "<"], ["gt", ">"], ["quot", '"'], ["apos", "'"], ["nbsp", "\u00a0"],
]);

function decodeEntities(text) {
  if (typeof text !== "string" || !text.includes("&")) return text || "";
  return text.replace(/&(#[xX]?[0-9a-fA-F]+|[a-zA-Z][a-zA-Z0-9]*);/g, (match, code) => {
    if (code[0] === "#") {
      const value = code[1] === "x" || code[1] === "X"
        ? Number.parseInt(code.slice(2), 16) : Number.parseInt(code.slice(1), 10);
      return Number.isFinite(value) && value > 0 && value <= 0x10ffff ? String.fromCodePoint(value) : match;
    }
    return ENTITIES.get(code.toLowerCase()) ?? match;
  });
}

const TOKEN = /<\/([A-Za-z_][\w.:-]*)\s*>|<([A-Za-z_][\w.:-]*)((?:\s+[^\s=/>]+\s*=\s*(?:"[^"]*"|'[^']*'))*)\s*(\/?)>|([^<]+)/g;
const ATTRIBUTE = /([^\s=/>]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g;

function parseAttributes(source) {
  const attrs = {};
  if (!source) return attrs;
  ATTRIBUTE.lastIndex = 0;
  let match;
  while ((match = ATTRIBUTE.exec(source))) attrs[match[1]] = decodeEntities(match[2] ?? match[3] ?? "");
  return attrs;
}

/** Parse a document into `{ name, attrs, children, text }` nodes. Text is only
 *  kept where it is not pure whitespace between child elements. */
function parseXml(source) {
  const root = { name: "#document", attrs: {}, children: [], text: "" };
  if (typeof source !== "string" || !source) return root;
  const stack = [root];
  const clean = source.replace(/<!--[\s\S]*?-->/g, "").replace(/<\?[\s\S]*?\?>/g, "");
  TOKEN.lastIndex = 0;
  let match;
  while ((match = TOKEN.exec(clean))) {
    if (match[1]) {
      // Pop to the matching open element, tolerating stray or missing closes.
      for (let index = stack.length - 1; index > 0; index--) {
        if (stack[index].name === match[1]) { stack.length = index; break; }
      }
      continue;
    }
    if (match[2]) {
      const node = { name: match[2], attrs: parseAttributes(match[3]), children: [], text: "" };
      stack[stack.length - 1].children.push(node);
      if (!match[4]) stack.push(node);
      continue;
    }
    if (match[5] !== undefined) {
      const text = decodeEntities(match[5]);
      if (text.trim()) stack[stack.length - 1].text += text;
    }
  }
  return root;
}

const child = (node, name) => node?.children.find(item => item.name === name);
const children = (node, name) => (node ? node.children.filter(item => item.name === name) : []);

function findAll(node, name, found = []) {
  if (!node) return found;
  for (const item of node.children) {
    if (item.name === name) found.push(item);
    findAll(item, name, found);
  }
  return found;
}

/** Text of the direct a:t children, which is what an OOXML run stores. */
function textOf(node) {
  return children(node, "a:t").map(item => item.text).join("");
}

module.exports = { decodeEntities, parseXml, child, children, findAll, textOf };
