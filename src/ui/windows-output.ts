// Ink's standard renderer erases the entire frame before repainting. Consoles
// without DECSET 2026 show that empty frame. Keep Ink's standard cursor model
// (including its trailing newline), but overwrite only changed rows on Windows.
export function createWindowsFrameWriter(): (chunk: string) => string {
  let previous: string[] | undefined;
  const erasePrefix = /^(?:\u001b\[2K\u001b\[1A)*\u001b\[2K\u001b\[G/;
  return (chunk) => {
    const prefix = erasePrefix.exec(chunk)?.[0] ?? "";
    const frame = chunk.slice(prefix.length);
    // Only optimize plain Ink frames with SGR styling. Unknown cursor commands,
    // clears, native cursor suffixes and log writes use the original path.
    const plain = frame.replace(/\u001b\[[\d;]*m/g, "");
    if (!frame.endsWith("\n") || /[\u001b\r\b]/.test(plain)) {
      // These controls do not move the cursor or alter frame contents.
      if (!/^(?:\u001b\[\?(?:2026|25|1000|1002|1003|1006|2004)[hl])+$/.test(chunk) && !/^\u001b\]52;/.test(chunk)) previous = undefined;
      return chunk;
    }
    const lines = frame.slice(0, -1).split("\n");
    const old = previous;
    previous = lines;
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

export function windowsOutput(stdout: NodeJS.WriteStream, platform = process.platform): NodeJS.WriteStream {
  if (platform !== "win32" || !stdout.isTTY || process.env.INK_SCREEN_READER === "true") return stdout;
  const transform = createWindowsFrameWriter();
  const write: NodeJS.WriteStream["write"] = (chunk: string | Uint8Array, ...args: unknown[]) => {
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
