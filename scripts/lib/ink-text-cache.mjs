/** Backport for Ink 6.8.0's process-wide text caches. Limit both entry count
 * and estimated retained bytes: a few huge streamed strings must not bypass
 * an entry-only limit. Eviction changes performance, never rendered output. */
export default class TextCache {
  #entries = new Map();
  #bytes = 0;

  constructor(maxEntries = 2048, maxBytes = 4 * 1024 * 1024) {
    this.maxEntries = maxEntries;
    this.maxBytes = maxBytes;
  }

  get size() { return this.#entries.size; }
  get bytes() { return this.#bytes; }

  get(key) {
    const entry = this.#entries.get(key);
    if (!entry) return undefined;
    this.#entries.delete(key);
    this.#entries.set(key, entry);
    return entry.value;
  }

  set(key, value) {
    const previous = this.#entries.get(key);
    if (previous) {
      this.#bytes -= previous.bytes;
      this.#entries.delete(key);
    }
    // UTF-16 strings, a fixed-size dimensions object, and entry overhead.
    const bytes = key.length * 2 + (typeof value === "string" ? value.length * 2 : 64) + 128;
    if (bytes > this.maxBytes || this.maxEntries < 1) return;
    // V8 can retain a whole streamed response behind a short sliced string.
    // Detach both keys and wrapped values so the byte budget also covers that
    // backing storage. UTF-16 preserves lone surrogates exactly.
    const copy = text => Buffer.from(text, "utf16le").toString("utf16le");
    this.#entries.set(copy(key), { value: typeof value === "string" ? copy(value) : value, bytes });
    this.#bytes += bytes;
    while (this.#entries.size > this.maxEntries || this.#bytes > this.maxBytes) {
      const oldest = this.#entries.keys().next().value;
      this.#bytes -= this.#entries.get(oldest).bytes;
      this.#entries.delete(oldest);
    }
  }
}
