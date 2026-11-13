// The 造物主 window's control session: one `luban drive` child per window.
//
// The window never runs a model in-process — it spawns the CLI exactly like the
// queue worker does, then pipes JSON lines each way. Two consequences worth
// stating: the model's tool calls happen in a process that can be killed with one
// signal (停止), and a crash or a reload of the renderer cannot take the session
// down with it, because the child outlives neither quietly nor mysteriously: it
// is killed on window close and on toggle off.
const { spawn } = require("node:child_process");
const bot = require("./bot.cjs");

const MAX_EVENTS = 400;

class DriveBridge {
  /**
   * @param {object} options
   * @param {(event: object) => void} options.onEvent forwarded to the renderer
   * @param {(text: string) => void} [options.onLog] stderr lines, for the log file
   */
  constructor(options) {
    this.options = options;
    this.child = undefined;
    this.buffer = "";
    this.ready = false;
    this.computer = { supported: false, enabled: false };
    this.events = [];
    this.lastError = "";
  }

  get running() {
    return Boolean(this.child);
  }

  snapshot() {
    return {
      running: this.running,
      ready: this.ready,
      computer: this.computer,
      events: this.events.slice(-MAX_EVENTS),
      error: this.lastError,
    };
  }

  /** Start the child. `computer` is the window's switch: it becomes LUBAN_COMPUTER. */
  start(workspace, options = {}) {
    if (this.child) return this.snapshot();
    this.workspace = workspace;
    const env = bot.nodeEnv(options.computer ? { LUBAN_COMPUTER: "1" } : {});
    delete env.LUBAN_GLOW_URL;
    const args = [bot.cliPath(), "drive", workspace];
    if (options.model) args.push("--model", options.model);
    if (!options.computer) args.push("--no-computer");
    const child = spawn(bot.nodeBinary(), args, { env, stdio: ["pipe", "pipe", "pipe"] });
    this.child = child;
    this.ready = false;
    this.lastError = "";
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", chunk => this.onStdout(chunk));
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", chunk => { this.options.onLog?.(String(chunk).trimEnd()); });
    child.on("error", error => {
      this.lastError = String(error.message || error);
      this.push({ type: "error", text: `操控进程启动失败：${this.lastError}` });
    });
    child.on("exit", (code, signal) => {
      this.child = undefined;
      this.ready = false;
      this.push({ type: "exit", code, signal: signal ?? undefined });
    });
    return this.snapshot();
  }

  stop() {
    if (!this.child) return this.snapshot();
    const child = this.child;
    this.send({ type: "stop" });
    // A model round trip can ignore SIGTERM long enough to be in the way; the
    // session's own stop() aborts the turn, so a short grace period is enough.
    const timer = setTimeout(() => { if (this.child === child) child.kill("SIGKILL"); }, 3000);
    timer.unref?.();
    child.kill("SIGTERM");
    this.child = undefined;
    this.ready = false;
    this.push({ type: "exit", code: null, signal: "SIGTERM" });
    return this.snapshot();
  }

  send(command) {
    if (!this.child?.stdin?.writable) return false;
    try {
      this.child.stdin.write(`${JSON.stringify(command)}\n`);
      return true;
    } catch (error) {
      this.lastError = String(error.message || error);
      return false;
    }
  }

  say(text) {
    const trimmed = String(text || "").trim();
    if (!trimmed) return false;
    // The window shows the user's line immediately; the child echoes the same
    // turn-start a moment later, and drawing both reads as a double send.
    this.echoPending = trimmed;
    this.push({ type: "turn-start", id: `local-${Date.now()}`, text: trimmed });
    return this.send({ type: "say", text: trimmed });
  }

  approve(id, allow) {
    return this.send({ type: "approve", id, allow: allow === true });
  }

  /** Line framing: one event per line, buffered until the newline arrives. */
  onStdout(chunk) {
    this.buffer += chunk;
    let newline = this.buffer.indexOf("\n");
    while (newline >= 0) {
      const line = this.buffer.slice(0, newline).trim();
      this.buffer = this.buffer.slice(newline + 1);
      if (line) this.onLine(line);
      newline = this.buffer.indexOf("\n");
    }
    // A runaway writer must not grow this buffer without bound.
    if (this.buffer.length > 4 * 1024 * 1024) this.buffer = "";
  }

  onLine(line) {
    let event;
    try { event = JSON.parse(line); }
    catch { this.options.onLog?.(`[drive] 非 JSON 输出：${line.slice(0, 200)}`); return; }
    if (!event || typeof event !== "object") return;
    if (event.type === "ready") {
      this.ready = true;
      this.computer = event.computer || { supported: false, enabled: false };
    }
    if (event.type === "error") this.lastError = String(event.text || "");
    if (event.type === "turn-start" && this.echoPending !== undefined) {
      const pending = this.echoPending;
      this.echoPending = undefined;
      if (pending === String(event.text || "")) return;
    }
    this.push(event);
  }

  push(event) {
    this.events.push(event);
    if (this.events.length > MAX_EVENTS) this.events = this.events.slice(-MAX_EVENTS);
    this.options.onEvent?.(event);
  }
}

module.exports = { DriveBridge, MAX_EVENTS };
