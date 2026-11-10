const { createReadStream } = require("node:fs");
const { Readable } = require("node:stream");

const MEDIA_SCHEME = "luban-media";

function rangeOf(target, request) {
  const range = /^bytes=(\d*)-(\d*)$/.exec(String(request.headers.get("range") || "").trim());
  let start = 0;
  let end = target.size - 1;
  if (!range) return { start, end, status: 200 };
  start = range[1] ? Number(range[1]) : 0;
  end = range[2] ? Math.min(Number(range[2]), target.size - 1) : target.size - 1;
  if (start > end || start >= target.size) return undefined;
  return { start, end, status: 206 };
}

/** Serve one workspace media file over luban-media://. A Range request answers
 *  206 so <video> can seek instead of buffering the whole file. `?entry=` names
 *  an image inside an archive (a slide deck) instead of a file on disk. */
function mediaResponse(service, request) {
  if (!service) return new Response("工作区未就绪", { status: 503 });
  const url = new URL(request.url);
  let value;
  try { value = decodeURIComponent(url.pathname.replace(/^\/+/, "")); }
  catch { return new Response("Invalid path", { status: 404 }); }
  const entryName = url.searchParams.get("entry");
  if (entryName !== null) {
    let entry;
    try { entry = service.archiveEntry(value, entryName); }
    catch (error) { return new Response(error instanceof Error ? error.message : "无法访问该文件", { status: 404 }); }
    const target = { size: entry.size };
    const slice = rangeOf(target, request);
    if (!slice) return new Response(null, { status: 416, headers: { "content-range": `bytes */${target.size}` } });
    const headers = {
      "content-type": entry.type, "accept-ranges": "bytes", "cache-control": "no-store",
      "content-length": String(Math.max(0, target.size ? slice.end - slice.start + 1 : 0)),
    };
    if (slice.status === 206) headers["content-range"] = `bytes ${slice.start}-${slice.end}/${target.size}`;
    if (request.method === "HEAD" || !target.size) return new Response(null, { status: slice.status, headers });
    return new Response(entry.bytes.subarray(slice.start, slice.end + 1), { status: slice.status, headers });
  }
  let target;
  try { target = service.mediaFile(value); }
  catch (error) { return new Response(error instanceof Error ? error.message : "无法访问该文件", { status: 404 }); }
  const slice = rangeOf(target, request);
  if (!slice) return new Response(null, { status: 416, headers: { "content-range": `bytes */${target.size}` } });
  const headers = { "content-type": target.type, "accept-ranges": "bytes", "cache-control": "no-store" };
  if (slice.status === 206) headers["content-range"] = `bytes ${slice.start}-${slice.end}/${target.size}`;
  headers["content-length"] = String(Math.max(0, target.size ? slice.end - slice.start + 1 : 0));
  if (request.method === "HEAD" || !target.size) return new Response(null, { status: slice.status, headers });
  return new Response(Readable.toWeb(createReadStream(target.file, { start: slice.start, end: slice.end })), { status: slice.status, headers });
}

module.exports = { MEDIA_SCHEME, mediaResponse };
