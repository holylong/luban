const fs = require("node:fs");
const path = require("node:path");
const { createHash, randomUUID } = require("node:crypto");
const { spawn } = require("node:child_process");
const { TextDecoder } = require("node:util");
const { openZip } = require("./zip.cjs");
const { readPptx, readXlsx, readDocx } = require("./office.cjs");
const { readDoc, readXls } = require("./office-legacy.cjs");
const { readDrawio, readDrawioPng } = require("./drawio.cjs");

// The editor holds the whole file in the renderer, so it stays bounded — but
// at 4 MB, past the lockfiles, logs and bundles people actually click in the
// tree. Media and terminal output have their own limits.
const MAX_FILE_BYTES = 4 * 1024 * 1024;
const MAX_FILE_MB = MAX_FILE_BYTES / (1024 * 1024);
// A one-shot command keeps the 1 MB console cap.
const MAX_COMMAND_BYTES = 1024 * 1024;
// A terminal streams far more than a one-shot command; cap it so a runaway
// `yes` cannot fill the renderer.
const MAX_TERMINAL_BYTES = 32 * 1024 * 1024;
const tooLarge = (limit = MAX_FILE_MB) => new Error(`File exceeds ${limit} MB limit`);
// Extensions the desktop preview can stream to <video>, <audio> and <img>.
const MEDIA_TYPES = new Map([
  [".mp4", "video/mp4"], [".m4v", "video/mp4"], [".webm", "video/webm"], [".ogv", "video/ogg"],
  [".mov", "video/quicktime"], [".mkv", "video/x-matroska"], [".avi", "video/x-msvideo"],
  [".mp3", "audio/mpeg"], [".m4a", "audio/mp4"], [".aac", "audio/aac"], [".wav", "audio/wav"],
  [".flac", "audio/flac"], [".ogg", "audio/ogg"], [".oga", "audio/ogg"], [".opus", "audio/opus"],
  [".png", "image/png"], [".jpg", "image/jpeg"], [".jpeg", "image/jpeg"], [".gif", "image/gif"],
  [".webp", "image/webp"], [".avif", "image/avif"], [".bmp", "image/bmp"], [".ico", "image/x-icon"],
  [".pdf", "application/pdf"],
]);
// Images a slide deck embeds; the preview streams them straight out of the zip.
const ARCHIVE_TYPES = new Map([
  [".png", "image/png"], [".jpg", "image/jpeg"], [".jpeg", "image/jpeg"], [".gif", "image/gif"],
  [".svg", "image/svg+xml"], [".webp", "image/webp"], [".bmp", "image/bmp"],
]);
// Office and diagram previews are parsed in the main process, so they keep a
// larger budget than text while still bounded.
const MAX_PREVIEW_BYTES = 96 * 1024 * 1024;
const MAX_PREVIEW_MB = MAX_PREVIEW_BYTES / (1024 * 1024);
const MAX_ARCHIVE_ENTRY_BYTES = 32 * 1024 * 1024;
const EXCLUDED = new Set([".git", "node_modules", "dist"]);
const revision = content => createHash("sha256").update(content).digest("hex");

function createWorkspace(root, emit = () => {}, options = {}) {
  root = fs.realpathSync(root);
  if (!fs.statSync(root).isDirectory()) throw new Error("Workspace must be a directory");
  const commands = new Map();
  const terminals = new Map();
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
    if (buffer.length > MAX_FILE_BYTES) throw tooLarge();
    // Saving rewrites bytes as UTF-8, so a UTF-16 file is refused with the reason
    // instead of being reported as binary.
    if (buffer.length >= 2 && ((buffer[0] === 0xff && buffer[1] === 0xfe) || (buffer[0] === 0xfe && buffer[1] === 0xff))) throw new Error("File is UTF-16 encoded, save it as UTF-8 first");
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
      if (stat.size > MAX_FILE_BYTES) throw tooLarge();
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
  // A media preview streams the file through luban-media://, so the text size
  // limit does not apply; only known media extensions are exposed.
  function mediaFile(value) {
    const target = checkedPath(value);
    const stat = fs.statSync(target);
    if (!stat.isFile()) throw new Error("Not a file");
    const type = MEDIA_TYPES.get(path.extname(value).toLowerCase());
    if (!type) throw new Error("Not a media file");
    return { path: value, file: target, size: stat.size, type };
  }
  /** Which parsed preview a path needs: office documents and draw.io diagrams
   *  are binary or XML, so the text editor cannot show them. */
  function previewKind(value) {
    const lower = String(value).toLowerCase();
    if (lower.endsWith(".drawio.png")) return "diagram-png";
    if (lower.endsWith(".drawio.svg") || lower.endsWith(".drawio.xml")) return "diagram";
    const extension = path.extname(lower);
    if (extension === ".drawio" || extension === ".dio") return "diagram";
    if (extension === ".pptx" || extension === ".pptm" || extension === ".ppsx") return "slides";
    if (extension === ".docx" || extension === ".docm" || extension === ".doc") return "word";
    if (extension === ".xlsx" || extension === ".xlsm" || extension === ".xltx" || extension === ".xls") return "sheet";
    return undefined;
  }
  function readPreview(value) {
    const kind = previewKind(value);
    if (!kind) throw new Error("这个文件没有预览");
    const target = checkedPath(value);
    const stat = fs.statSync(target);
    if (!stat.isFile()) throw new Error("Not a file");
    if (stat.size > MAX_PREVIEW_BYTES) throw new Error(`File exceeds ${MAX_PREVIEW_MB} MB preview limit`);
    const buffer = fs.readFileSync(target);
    const extension = path.extname(String(value).toLowerCase());
    if (kind === "slides") return { ...readPptx(buffer), path: value };
    if (kind === "word") return { ...(extension === ".doc" ? readDoc(buffer) : readDocx(buffer)), path: value };
    if (kind === "sheet") return { ...(extension === ".xls" ? readXls(buffer) : readXlsx(buffer)), path: value };
    if (kind === "diagram-png") return { ...readDrawioPng(buffer), path: value };
    return { ...readDrawio(buffer.toString("utf8")), path: value };
  }
  /** One image entry inside a workspace archive (a pptx), streamed to the
   *  preview without unpacking anything onto disk. */
  function archiveEntry(value, entryName) {
    if (typeof entryName !== "string" || !entryName || entryName.length > 512 || entryName.includes("\0")) throw new Error("Invalid archive entry");
    const type = ARCHIVE_TYPES.get(path.extname(entryName).toLowerCase());
    if (!type) throw new Error("Not an image entry");
    const target = checkedPath(value);
    const stat = fs.statSync(target);
    if (!stat.isFile()) throw new Error("Not a file");
    if (stat.size > MAX_PREVIEW_BYTES) throw tooLarge(MAX_PREVIEW_MB);
    const bytes = openZip(fs.readFileSync(target)).read(entryName);
    if (!bytes) throw new Error("Archive entry not found");
    if (bytes.length > MAX_ARCHIVE_ENTRY_BYTES) throw tooLarge(MAX_ARCHIVE_ENTRY_BYTES / (1024 * 1024));
    return { path: `${value}!${entryName}`, bytes, size: bytes.length, type };
  }
  /** Resolve a workspace path for the OS opener, keeping the same containment
   *  checks as the editor. */
  function absolutePath(value) {
    return checkedPath(value);
  }
  /** A path that may not exist yet: the parent must be inside the workspace and
   *  the new name must survive the same checks as an existing entry. */
  function resolveNew(value) {
    assertActive();
    if (typeof value !== "string" || !value || value.includes("\0") || value.includes("\\") || path.isAbsolute(value) || /^[a-z]:/i.test(value)) throw new Error("Invalid workspace path");
    const parts = value.split("/");
    const name = parts.pop();
    if (!name || name === "." || name === ".." || EXCLUDED.has(name)) throw new Error("Invalid workspace path");
    const parent = parts.length ? checkedPath(parts.join("/")) : root;
    if (!fs.lstatSync(parent).isDirectory()) throw new Error("Parent is not a directory");
    return path.join(parent, name);
  }
  /** Create one empty file or folder; the tree refreshes from its poll. */
  function createEntry(input = {}) {
    const target = resolveNew(input.path);
    const kind = input.kind === "dir" ? "dir" : "file";
    if (fs.existsSync(target)) throw new Error("A file or folder with that name already exists");
    if (kind === "dir") fs.mkdirSync(target);
    else fs.writeFileSync(target, "", { flag: "wx" });
    return { path: input.path, kind };
  }
  /** Rename in place. Moving between folders would leave the editor pointing at
   *  a path that no longer exists, so a cross-folder request is refused. */
  function renameEntry(input = {}) {
    const source = checkedPath(input.from);
    const target = resolveNew(input.to);
    if (path.dirname(target) !== path.dirname(source)) throw new Error("Rename must stay in the same folder");
    if (fs.existsSync(target)) throw new Error("A file or folder with that name already exists");
    fs.renameSync(source, target);
    return { from: input.from, to: input.to };
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
      const remaining = (options.maxOutputBytes || MAX_COMMAND_BYTES) - record.bytes;
      if (remaining <= 0) return;
      const data = chunk.subarray(0, remaining);
      record.bytes += data.length;
      emit({ id, kind: "output", text: data.toString("utf8") });
      if (record.bytes >= (options.maxOutputBytes || MAX_COMMAND_BYTES)) stopCommand(id);
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
  // A terminal needs a pty for prompts, colours and `cd`, which Node cannot
  // allocate. A small Python bridge owns the pty and zero-copy-filters bytes;
  // `script` is the fallback, and a plain pipe is the last resort.
  const PTY_BRIDGE = String.raw`
import os, pty, sys, select, signal
import fcntl, termios, struct
cols, rows, shell = int(sys.argv[1]), int(sys.argv[2]), sys.argv[3]
pid, fd = pty.fork()
if pid == 0:
    try:
        env = dict(os.environ)
        env["TERM"] = "xterm-256color"
        os.execvpe(shell, [shell, "-il"], env)
    except OSError:
        os._exit(127)
def setsize(c, r):
    try:
        fcntl.ioctl(fd, termios.TIOCSWINSZ, struct.pack("HHHH", r, c, 0, 0))
    except OSError:
        pass
setsize(cols, rows)
# fd 3 carries "resize COLS ROWS" lines, so the shell follows the panel without
# a restart. It is optional: older launchers only hand us the three stdio pipes.
try:
    control = os.fdopen(3, "r")
except OSError:
    control = None
try:
    while True:
        ready, _, _ = select.select([0, fd] + ([3] if control else []), [], [])
        if control is not None and 3 in ready:
            line = control.readline()
            if not line:
                control = None
            else:
                parts = line.split()
                if len(parts) == 3 and parts[0] == "resize":
                    try:
                        setsize(int(parts[1]), int(parts[2]))
                    except ValueError:
                        pass
        if 0 in ready:
            data = os.read(0, 65536)
            if not data:
                break
            os.write(fd, data)
        if fd in ready:
            try:
                data = os.read(fd, 65536)
            except OSError:
                break
            if not data:
                break
            os.write(1, data)
except (KeyboardInterrupt, OSError):
    pass
finally:
    try:
        os.kill(pid, signal.SIGHUP)
    except OSError:
        pass
`;
  function resolvePython() {
    return ["/usr/bin/python3", "/usr/local/bin/python3", "/opt/homebrew/bin/python3", "/usr/bin/python"].find(candidate => fs.existsSync(candidate));
  }
  function terminalSize(value, fallback, min, max) {
    const size = Number(value);
    if (!Number.isFinite(size)) return fallback;
    return Math.min(max, Math.max(min, Math.round(size)));
  }
  function resolveShell() {
    if (process.platform === "win32") return process.env.ComSpec || "cmd.exe";
    const candidate = process.env.SHELL;
    if (candidate && path.isAbsolute(candidate) && fs.existsSync(candidate)) return candidate;
    return "/bin/sh";
  }
  function terminalLaunch(cols, rows) {
    const shell = resolveShell();
    if (process.platform !== "win32") {
      const python = resolvePython();
      if (python) return { command: python, args: ["-c", PTY_BRIDGE, String(cols), String(rows), shell], pty: true, shell, control: true };
      const script = ["/usr/bin/script", "/bin/script"].find(candidate => fs.existsSync(candidate));
      if (script) {
        const boot = `stty rows ${rows} cols ${cols} 2>/dev/null; exec '${shell.replaceAll("'", "'\\''")}' -il`;
        const args = process.platform === "darwin"
          ? ["-q", "/dev/null", "/bin/sh", "-c", boot]
          : ["-q", "-f", "-e", "-c", boot, "/dev/null"];
        return { command: script, args, pty: true, shell };
      }
    }
    return { command: shell, args: [], pty: false, shell };
  }
  function startTerminal(input = {}) {
    assertActive();
    if (terminals.size >= (options.maxTerminals || 1)) throw new Error("A terminal is already running");
    const cols = terminalSize(input.cols, 100, 20, 400);
    const rows = terminalSize(input.rows, 30, 5, 200);
    const launch = terminalLaunch(cols, rows);
    const id = randomUUID();
    const child = spawn(launch.command, launch.args, {
      cwd: root,
      env: { ...process.env, TERM: "xterm-256color", COLUMNS: String(cols), LINES: String(rows) },
      detached: process.platform !== "win32",
      // fd 3 is the resize channel; only the pty bridge understands it.
      stdio: launch.control ? ["pipe", "pipe", "pipe", "pipe"] : ["pipe", "pipe", "pipe"],
      windowsHide: true,
    });
    const control = launch.control ? child.stdio[3] : null;
    control?.on("error", () => {});
    const record = { child, bytes: 0, pty: launch.pty, control, cols, rows };
    terminals.set(id, record);
    const limit = options.maxTerminalBytes || MAX_TERMINAL_BYTES;
    const output = chunk => {
      if (disposed) return;
      const remaining = limit - record.bytes;
      if (remaining <= 0) return;
      const data = chunk.subarray(0, remaining);
      record.bytes += data.length;
      emit({ id, kind: "output", text: data.toString("utf8") });
      if (record.bytes >= limit) {
        emit({ id, kind: "output", text: "\r\n[终端输出已达上限，已关闭]\r\n" });
        stopTerminal(id);
      }
    };
    child.stdout.on("data", output);
    child.stderr.on("data", output);
    // A shell may exit while a write is still in flight.
    child.stdin.on("error", () => {});
    child.on("error", error => {
      terminals.delete(id);
      if (!disposed) emit({ id, kind: "output", text: `\r\n${error.message}\r\n` });
    });
    child.on("close", (code, signal) => {
      kill(child, "SIGKILL");
      terminals.delete(id);
      if (!disposed) emit({ id, kind: "exit", text: signal ? `Signal ${signal}` : `Exit ${code}` });
    });
    return { id, pty: launch.pty, cols, rows, shell: launch.shell };
  }
  function writeTerminal(input) {
    assertActive();
    if (!input || typeof input.id !== "string" || typeof input.data !== "string") throw new Error("Invalid terminal input");
    if (input.data.length > 65536) throw new Error("Terminal input is too large");
    const record = terminals.get(input.id);
    if (!record) throw new Error("Terminal is not running");
    record.child.stdin.write(input.data);
    return { ok: true };
  }
  /** Match the pty to the panel after a drag or window resize. */
  function resizeTerminal(input) {
    assertActive();
    const cols = terminalSize(input?.cols, 0, 20, 400);
    const rows = terminalSize(input?.rows, 0, 5, 200);
    const record = terminals.get(input?.id);
    if (!record) throw new Error("Terminal is not running");
    if (!record.control) return { ok: true, resized: false };
    record.control.write(`resize ${cols} ${rows}\n`);
    record.cols = cols;
    record.rows = rows;
    return { ok: true, resized: true };
  }
  function stopTerminal(id) {
    if (disposed || typeof id !== "string") return { ok: true };
    const record = terminals.get(id);
    if (!record) return { ok: true };
    terminals.delete(id);
    kill(record.child, "SIGHUP");
    const timer = setTimeout(() => kill(record.child, "SIGKILL"), 400);
    timer.unref?.();
    return { ok: true };
  }
  function dispose() {
    if (disposed) return;
    for (const record of commands.values()) { clearTimeout(record.timer); kill(record.child, "SIGKILL"); }
    for (const record of terminals.values()) kill(record.child, "SIGKILL");
    terminals.clear();
    disposed = true;
  }
  return {
    readFile, saveFile, mediaFile, listFiles, readPreview, archiveEntry, absolutePath, createEntry, renameEntry, runCommand, stopCommand,
    startTerminal, writeTerminal, resizeTerminal, stopTerminal, dispose,
  };
}

module.exports = { createWorkspace, MAX_FILE_BYTES };
