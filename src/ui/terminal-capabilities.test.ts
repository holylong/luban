import { expect, it } from "vitest";
import { detectTerminalCapabilities } from "./terminal-capabilities.js";

const ssh = { SSH_CONNECTION: "10.0.0.2 50022 10.0.0.5 22", SSH_TTY: "/dev/pts/1" };

it("keeps an explicit color opt-out above everything else", () => {
  expect(detectTerminalCapabilities({ TERM: "xterm-256color", NO_COLOR: "" }, { isTTY: true }).colorLevel).toBe(0);
  expect(detectTerminalCapabilities({ ...ssh, TERM: "xterm-256color", NO_COLOR: "1" }, { isTTY: true }).colorLevel).toBe(0);
  expect(detectTerminalCapabilities({ TERM: "dumb" }, { isTTY: true }).colorLevel).toBe(0);
  expect(detectTerminalCapabilities({ FORCE_COLOR: "0", TERM: "xterm-256color" }, { isTTY: true }).colorLevel).toBe(0);
  expect(detectTerminalCapabilities({ TERM: "xterm-256color" }, { isTTY: false }).colorLevel).toBe(0);
  // NO_COLOR=0/false is the widespread way of saying "not really".
  expect(detectTerminalCapabilities({ TERM: "xterm-256color", NO_COLOR: "0" }, { isTTY: true }).colorLevel).toBe(2);
});

it("honours truecolor hints and explicit force levels", () => {
  expect(detectTerminalCapabilities({ TERM: "xterm-256color", COLORTERM: "truecolor" }, { isTTY: true })).toMatchObject({ colorLevel: 3, trueColor: true });
  expect(detectTerminalCapabilities({ TERM: "xterm-256color", COLORTERM: "24bit" }, { isTTY: true }).trueColor).toBe(true);
  expect(detectTerminalCapabilities({ FORCE_COLOR: "3" }, { isTTY: true }).colorLevel).toBe(3);
  expect(detectTerminalCapabilities({ FORCE_COLOR: "1", COLORTERM: "truecolor" }, { isTTY: true }).colorLevel).toBe(1);
});

it("gives a remote shell 256 colors when ssh forwards no COLORTERM", () => {
  // The reported bug: styled locally, flat text after `ssh ubuntu`, because
  // TERM=xterm alone maps to the 16-color palette.
  const remote = detectTerminalCapabilities({ ...ssh, TERM: "xterm" }, { isTTY: true });
  expect(remote).toMatchObject({ colorLevel: 2, remote: true, trueColor: false });
  expect(remote.reason).toContain("remote shell");
  const unset = detectTerminalCapabilities({ ...ssh }, { isTTY: true });
  expect(unset.colorLevel).toBe(2);
  expect(unset.reason).toContain("unset");
  // A local console keeps the conservative answer: no guessing on its behalf.
  expect(detectTerminalCapabilities({ TERM: "xterm" }, { isTTY: true }).colorLevel).toBe(1);
});

it("reports the reason so a remote session can be diagnosed", () => {
  expect(detectTerminalCapabilities({ ...ssh, TERM: "xterm-256color" }, { isTTY: true }).reason).toBe("TERM=xterm-256color");
  expect(detectTerminalCapabilities({ TERM: "xterm-256color", COLORTERM: "truecolor" }, { isTTY: true }).reason).toBe("COLORTERM=truecolor");
  expect(detectTerminalCapabilities({ TERM: "xterm-256color" }, { isTTY: false }).reason).toBe("output is not a terminal");
});
