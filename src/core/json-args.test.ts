import { describe, expect, it } from "vitest";
import { escapeControlCharsInStrings, parseToolArguments } from "./json-args.js";

describe("parseToolArguments", () => {
  it("parses well-formed arguments unchanged", () => {
    expect(parseToolArguments('{"command":"ls -la","cwd":"/tmp"}')).toEqual({ command: "ls -la", cwd: "/tmp" });
  });

  it("recovers a command with a literal newline inside the string", () => {
    // What a model emits when it forgets to escape the newline: JSON.parse
    // rejects the raw control character before the tool ever runs.
    const raw = '{"command":"set -e\nnpm test\ngit status"}';
    expect(() => JSON.parse(raw)).toThrow();
    expect(parseToolArguments(raw)).toEqual({ command: "set -e\nnpm test\ngit status" });
  });

  it("recovers tabs and other control characters but leaves structure alone", () => {
    const raw = '{\n  "command":\t"echo\\tone\ttwo"\n}';
    expect(parseToolArguments(raw)).toEqual({ command: "echo\tone\ttwo" });
  });

  it("still rejects genuinely malformed arguments", () => {
    expect(() => parseToolArguments('{"command":')).toThrow();
    expect(() => parseToolArguments('{"command":"unterminated}')).toThrow();
  });

  it("treats an empty payload as an empty object", () => {
    expect(parseToolArguments("")).toEqual({});
  });
});

describe("escapeControlCharsInStrings", () => {
  it("does not touch control characters outside strings", () => {
    const text = '{\n\t"a": "b\nc"\n}';
    expect(escapeControlCharsInStrings(text)).toBe('{\n\t"a": "b\\nc"\n}');
  });

  it("keeps an already escaped sequence as written", () => {
    expect(escapeControlCharsInStrings('{"a":"line\\nbreak"}')).toBe('{"a":"line\\nbreak"}');
  });
});
