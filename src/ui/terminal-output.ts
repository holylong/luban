import { appendFileSync } from "node:fs";

// Ink's standard renderer erases the entire frame before repainting. Consoles
// without DECSET 2026 show that empty frame, especially during reasoning streams.
// Full workbench frames use absolute rows, repairing stale cells independently
// of cursor drift. Smaller outputs retain Ink's standard trailing cursor model.
/** Unchanged rows are still repainted this often, to heal anything that wrote over them. */
const FULL_REPAINT_EVERY = 120;

/** `LUBAN_TUI_TRACE=/tmp/tui.log` records one line per write: which path was
 * taken and how much of the screen it touched. Diagnosing "it flickers over ssh"
 * needs the real frames, and they cannot be reproduced on another machine. */
function tracer(): ((line: string) => void) | undefined {
  const path = process.env.LUBAN_TUI_TRACE;
  if (!path) return undefined;
  let logged = 0;
  return (line) => {
    if (logged++ > 4000) return;
    try { appendFileSync(path, `${new Date().toISOString()} ${line}\n`); } catch { /* tracing must never break the UI */ }
  };
}

export function createTerminalFrameWriter(size?: () => { rows: number; columns: number }): (chunk: string) => string {
  let previous: string[] | undefined;
  let paintedRows = -1;
  let frames = 0;
  const trace = tracer();
  const erasePrefix = /^(?:\u001b\[2K\u001b\[1A)*\u001b\[2K\u001b\[G/;
  return (chunk) => {
    const prefix = erasePrefix.exec(chunk)?.[0] ?? "";
    const frame = chunk.slice(prefix.length);
    // Only optimize plain Ink frames with SGR styling. Unknown cursor commands,
    // clears, native cursor suffixes and log writes use the original path.
    const plain = frame.replace(/\u001b\[[\d;]*m/g, "");
    if (!frame.endsWith("\n") || /[\u001b\r\b]/.test(plain)) {
      // These controls do not move the cursor or alter frame contents.
      const control = /^(?:\u001b\[\?(?:2026|25|1000|1002|1003|1006|2004)[hl])+$/.test(chunk) || /^\u001b\]52;/.test(chunk);
      if (!control) previous = undefined;
      trace?.(`ink bytes=${chunk.length} rows=${frame.split("\n").length - 1} erase2k=${(chunk.match(/\u001b\[2K/g) ?? []).length}${control ? " control" : ""}`);
      return chunk;
    }
    const lines = frame.slice(0, -1).split("\n");
    const old = previous;
    previous = lines;
    const dimensions = size?.();
    // Any frame that fits the viewport can be painted with absolute rows; a
    // strict "rows - 1" check silently dropped every other layout back to Ink's
    // erase-and-repaint path, which is what flickers on a slow ssh link.
    if (dimensions && lines.length > 0 && lines.length <= dimensions.rows) {
      // The workbench owns the viewport. Never trust a relative cursor origin:
      // autowrap, bottom scrolling and resize can leave it a row away from Ink's
      // model. Absolute row addresses also repair remnants of earlier frames.
      //
      // Only rows whose text changed are repainted. A keystroke that redraws one
      // row used to cost a full-screen repaint; over ssh that is what makes the
      // console flicker. Anything that can leave a row stale (external writes,
      // binary output, a resize) clears `previous` or changes the frame height,
      // and an unchanged frame is still fully repainted every FULL_REPAINT_EVERY
      // frames as a safety net.
      frames += 1;
      const repaintAll = !old || old.length !== lines.length || lines.length !== paintedRows
        || frames % FULL_REPAINT_EVERY === 0;
      let output = "";
      let painted = 0;
      for (let row = 0; row < lines.length; row++) {
        if (!repaintAll && old[row] === lines[row]) continue;
        output += `\u001b[${row + 1};1H${lines[row]}\u001b[K`;
        painted += 1;
      }
      paintedRows = lines.length;
      trace?.(`absolute rows=${lines.length}/${dimensions.rows} painted=${painted} bytes=${output.length}`);
      return `${output}\u001b[${dimensions.rows};1H\u001b[K`;
    }
    const erasedRows = prefix.match(/\u001b\[2K/g)?.length ?? 0;
    if (!old || lines.length !== old.length || erasedRows !== old.length + 1) return chunk;

    // Cursor rests BELOW the frame, not on its last visible row. Moving up
    // old.length - 1 (as Ink's incremental renderer does) causes row drift.
    let output = `\u001b[${old.length}A\u001b[G`;
    for (let row = 0; row < lines.length; row++) {
      output += lines[row] === old[row]
        ? "\u001b[E"
        : `\u001b[G${lines[row]}\u001b[K\n`;
    }
    return output;
  };
}

export function terminalOutput(stdout: NodeJS.WriteStream): NodeJS.WriteStream {
  if (!stdout.isTTY || process.env.INK_SCREEN_READER === "true") return stdout;
  const transform = createTerminalFrameWriter(() => ({ rows: stdout.rows, columns: stdout.columns }));
  const write: NodeJS.WriteStream["write"] = (chunk: string | Uint8Array, ...args: unknown[]) => {
    // A binary/external write may move the cursor. Re-establish the frame on
    // the next render rather than applying a diff against stale terminal state.
    if (typeof chunk !== "string") transform("");
    const output = typeof chunk === "string" ? transform(chunk) : chunk;
    return Reflect.apply(stdout.write, stdout, [output, ...args]) as boolean;
  };
  // Bind stream methods to the real terminal so resize events, dimensions,
  // backpressure, callbacks and Ink's shutdown barrier keep working normally.
  return new Proxy(stdout, {
    get(target, property) {
      if (property === "write") return write;
      const value = Reflect.get(target, property, target);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
}
