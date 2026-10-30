const fs = require("node:fs");
const path = require("node:path");
const { createHash, randomUUID } = require("node:crypto");
const { spawn } = require("node:child_process");
const { TextDecoder } = require("node:util");

const MAX_FILE_BYTES = 1024 * 1024;
const EXCLUDED = new Set([".git", "node_modules", "dist"]);
const revision = content => createHash("sha256").update(content).digest("hex");

function createWorkspace(root, emit = () => {}, options = {}) {
  root = fs.realpathSync(root);
  if (!fs.statSync(root).isDirectory()) throw new Error("Workspace must be a directory");
  const commands = new Map();
  let disposed = false;
  const assertActive = () => { if (disposed) throw new Error("Workspace closed"); };
  function checkedPath(value) {
    assertActive();
    if (typeof value !== "string" || !value || value.includes("\0") || value.includes("\\") || path.isAbsolute(value) || /^[a-z]:/i.test(value)) throw new Error("Invalid workspace path");
    const parts = value.split("/");
    if (parts.some(part => !part || part === "." || part === ".." || EXCLUDED.has(part))) throw new Error("Invalid workspace path");
    let target = root;
    for (const part of parts) {
      target = path.join(target, part);
      if (fs.lstatSync(target).isSymbolicLink()) throw new Error("Symlinks are not allowed");
    }
    const real = fs.realpathSync(target);
    const relative = path.relative(root, real);
    if (!relative || relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) throw new Error("Path escapes workspace");
    return target;
  }
  function decode(buffer) {
    if (buffer.length > MAX_FILE_BYTES) throw new Error("File exceeds 1 MB limit");
    if (buffer.includes(0)) throw new Error("Binary files are not supported");
    let text;
    try { text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(buffer); }
    catch { throw new Error("File is not valid UTF-8"); }
    if (/[\x01-\x08\x0b\x0c\x0e-\x1f]/.test(text)) throw new Error("Binary files are not supported");
    return text;
  }
  function open(value, flags) {
    const target = checkedPath(value);
    const fd = fs.openSync(target, flags | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
    try {
      const stat = fs.fstatSync(fd);
      const current = fs.statSync(checkedPath(value));
      if (!stat.isFile() || stat.ino !== current.ino || stat.dev !== current.dev) throw new Error("File changed while opening");
      if (stat.size > MAX_FILE_BYTES) throw new Error("File exceeds 1 MB limit");
      return fd;
    } catch (error) { fs.closeSync(fd); throw error; }
  }
  function readBuffer(fd) {
    const buffer = Buffer.alloc(MAX_FILE_BYTES + 1);
    let length = 0;
    while (length < buffer.length) {
      const count = fs.readSync(fd, buffer, length, buffer.length - length, length);
      if (!count) break;
      length += count;
    }
    return buffer.subarray(0, length);
  }
  function readFile(value) {
    const fd = open(value, fs.constants.O_RDONLY);
    try {
      const buffer = readBuffer(fd);
      return { path: value, content: decode(buffer), revision: revision(buffer) };
    } finally { fs.closeSync(fd); }
  }
  function saveFile(input) {
    if (!input || typeof input.content !== "string" || typeof input.revision !== "string") throw new Error("Invalid save request");
    const buffer = Buffer.from(input.content, "utf8");
    if (decode(buffer) !== input.content) throw new Error("Invalid UTF-8 content");
    const fd = open(input.path, fs.constants.O_RDWR);
    try {
      const before = readBuffer(fd);
      decode(before);
      if (revision(before) !== input.revision) throw new Error("Revision conflict: file changed on disk");
      let written = 0;
      while (written < buffer.length) written += fs.writeSync(fd, buffer, written, buffer.length - written, written);
      fs.ftruncateSync(fd, buffer.length);
      fs.fsyncSync(fd);
      return { path: input.path, content: input.content, revision: revision(buffer) };
    } finally { fs.closeSync(fd); }
  }
  function listFiles() {
    assertActive();
    const files = [];
    let visited = 0;
    function walk(directory, depth) {
      if (depth > 32 || visited >= 20000 || files.length >= 5000) return;
      const handle = fs.opendirSync(directory);
      try {
        let entry;
        while (visited < 20000 && files.length < 5000 && (entry = handle.readSync())) {
          visited++;
          if (EXCLUDED.has(entry.name) || entry.isSymbolicLink()) continue;
          const absolute = path.join(directory, entry.name);
          const relative = path.relative(root, absolute).split(path.sep).join("/");
          try {
            checkedPath(relative);
            if (entry.isDirectory()) walk(absolute, depth + 1);
            else if (entry.isFile()) files.push(relative);
          } catch { /* Entries may disappear or become inaccessible during a scan. */ }
        }
      } finally { handle.closeSync(); }
    }
    walk(root, 0);
    return files.sort();
  }
  function kill(child, signal) {
    if (!child.pid) return;
    try {
      if (process.platform === "win32") {
        spawn("taskkill", ["/pid", String(child.pid), "/T", "/F"], { stdio: "ignore", windowsHide: true }).on("error", () => {});
      } else process.kill(-child.pid, signal);
    } catch (error) { if (error.code !== "ESRCH") throw error; }
  }
  function stopCommand(id) {
    assertActive();
    if (typeof id !== "string") throw new Error("Invalid command id");
    const record = commands.get(id);
    if (!record || record.stopping) return;
    record.stopping = true;
    kill(record.child, "SIGTERM");
    record.timer = setTimeout(() => kill(record.child, "SIGKILL"), 500);
    record.timer.unref();
  }
  function runCommand(command) {
    assertActive();
    if (typeof command !== "string" || !command.trim() || command.length > 8192 || command.includes("\0")) throw new Error("Invalid command");
    if (commands.size >= (options.maxCommands || 3)) throw new Error("Too many concurrent commands");
    const id = randomUUID();
    const child = spawn(command, { shell: true, cwd: root, detached: process.platform !== "win32", stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
    const record = { child, bytes: 0, stopping: false, timer: undefined };
    commands.set(id, record);
    const output = chunk => {
      if (disposed) return;
      const remaining = (options.maxOutputBytes || MAX_FILE_BYTES) - record.bytes;
      if (remaining <= 0) return;
      const data = chunk.subarray(0, remaining);
      record.bytes += data.length;
      emit({ id, kind: "output", text: data.toString("utf8") });
      if (record.bytes >= (options.maxOutputBytes || MAX_FILE_BYTES)) stopCommand(id);
    };
    child.stdout.on("data", output);
    child.stderr.on("data", output);
    child.on("error", error => { if (!disposed) emit({ id, kind: "output", text: error.message }); });
    child.on("close", (code, signal) => {
      // The shell may exit before its descendants; always clean up the group.
      kill(child, "SIGKILL");
      clearTimeout(record.timer);
      commands.delete(id);
      if (!disposed) emit({ id, kind: "exit", text: signal ? `Signal ${signal}` : `Exit ${code}` });
    });
    return { id };
  }
  function dispose() {
    if (disposed) return;
    for (const record of commands.values()) { clearTimeout(record.timer); kill(record.child, "SIGKILL"); }
    disposed = true;
  }
  return { readFile, saveFile, listFiles, runCommand, stopCommand, dispose };
}

module.exports = { createWorkspace, MAX_FILE_BYTES };
