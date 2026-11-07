const { createReadStream } = require("node:fs");
const { Readable } = require("node:stream");

const MEDIA_SCHEME = "luban-media";

/** Serve one workspace media file over luban-media://. A Range request answers
 * 206 so <video> can seek instead of buffering the whole file. */
function mediaResponse(service, request) {
  if (!service) return new Response("工作区未就绪", { status: 503 });
  let target;
  try { target = service.mediaFile(decodeURIComponent(new URL(request.url).pathname.replace(/^\/+/, ""))); }
  catch (error) { return new Response(error instanceof Error ? error.message : "无法访问该文件", { status: 404 }); }
  const range = /^bytes=(\d*)-(\d*)$/.exec(String(request.headers.get("range") || "").trim());
  let start = 0;
  let end = target.size - 1;
  const headers = { "content-type": target.type, "accept-ranges": "bytes", "cache-control": "no-store" };
  if (range) {
    start = range[1] ? Number(range[1]) : 0;
    end = range[2] ? Math.min(Number(range[2]), target.size - 1) : target.size - 1;
    if (start > end || start >= target.size) return new Response(null, { status: 416, headers: { "content-range": `bytes */${target.size}` } });
    headers["content-range"] = `bytes ${start}-${end}/${target.size}`;
  }
  const status = range ? 206 : 200;
  headers["content-length"] = String(Math.max(0, target.size ? end - start + 1 : 0));
  if (request.method === "HEAD" || !target.size) return new Response(null, { status, headers });
  return new Response(Readable.toWeb(createReadStream(target.file, { start, end })), { status, headers });
}

module.exports = { MEDIA_SCHEME, mediaResponse };
