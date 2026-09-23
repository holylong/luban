// Mock LSP server for tests: Content-Length framing without any backslash
// escapes in this file, so no template or shell layer can corrupt it.
const CRLF = String.fromCharCode(13, 10, 13, 10);
let buffer = Buffer.alloc(0);

function send(obj, id) {
  const body = Buffer.from(JSON.stringify({ jsonrpc: "2.0", id, ...obj }), "utf8");
  process.stdout.write(Buffer.concat([Buffer.from("Content-Length: " + body.length + CRLF), body]));
}

function notify(method, params) {
  const body = Buffer.from(JSON.stringify({ jsonrpc: "2.0", method, params }), "utf8");
  process.stdout.write(Buffer.concat([Buffer.from("Content-Length: " + body.length + CRLF), body]));
}

function contentLength(header) {
  const parts = String(header).split(":");
  return Number((parts[1] || "").trim());
}

process.stdin.on("data", (chunk) => {
  buffer = Buffer.concat([buffer, chunk]);
  for (;;) {
    const end = buffer.indexOf(CRLF);
    if (end < 0) return;
    const len = contentLength(buffer.subarray(0, end).toString());
    if (!len || buffer.length < end + 4 + len) return;
    const msg = JSON.parse(buffer.subarray(end + 4, end + 4 + len).toString("utf8"));
    buffer = buffer.subarray(end + 4 + len);
    if (msg.method === "initialize") {
      send({ result: { capabilities: {} } }, msg.id);
    } else if (msg.method === "textDocument/didOpen") {
      const uri = msg.params.textDocument.uri;
      notify("textDocument/publishDiagnostics", {
        uri,
        diagnostics: [{ range: { start: { line: 3, character: 0 }, end: { line: 3, character: 4 } }, severity: 2, code: "W001", message: "mock published warning" }],
      });
    } else if (msg.method === "textDocument/diagnostic") {
      send({ result: { kind: "full", items: [{ range: { start: { line: 1, character: 0 }, end: { line: 1, character: 5 } }, severity: 1, code: "E999", message: "mock syntax error" }] } }, msg.id);
    } else if (msg.method && msg.id !== undefined) {
      send({ result: null }, msg.id);
    }
  }
});
