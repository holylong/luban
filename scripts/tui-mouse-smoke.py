#!/usr/bin/env python3
"""Mouse smoke test: a click in the composer must place the caret, never text.

Runs the real TUI on a PTY and feeds it the three mouse-report encodings a
terminal may use once tracking is on:

  * SGR   ESC [ < button ; column ; row M      (?1006, the modern form)
  * rxvt  ESC [ button ; column ; row M        (1015, ignored ?1006)
  * X10   ESC [ M <button> <column> <row>      (1000, ignored ?1006)

For each one the run types a value, clicks inside the composer, and then types
a marker character: the composer must hold exactly value + marker, with the
marker inserted at the clicked cell, and no report payload anywhere.

Usage: python3 scripts/tui-mouse-smoke.py            # all three encodings
       DUMP=1 python3 scripts/tui-mouse-smoke.py sgr # plus the raw frames
"""
import fcntl
import json
import os
import pty
import re
import select
import signal
import socket
import struct
import subprocess
import sys
import tempfile
import termios
import time

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
ANSI = re.compile(r"\x1b\[[0-9;?]*[a-zA-Z]")
OSC = re.compile(r"\x1b\][^\x07]*\x07")
ROWS, COLS = 30, 100
VALUE = "abcdefghij"
CLICK_AT = 3  # marker must land before the fourth character


def free_port() -> int:
    with socket.socket() as sock:
        sock.bind(("127.0.0.1", 0))
        return sock.getsockname()[1]


def report(encoding: str, column: int, row: int, button: int = 0, release: bool = False) -> bytes:
    """One press (or release) in the requested encoding."""
    if encoding == "sgr":
        return f"\x1b[<{button};{column};{row}{'m' if release else 'M'}".encode()
    if encoding == "urxvt":
        code = 35 if release else button + 32
        return f"\x1b[{code};{column};{row}M".encode()
    if encoding == "x10":
        code = 3 if release else button
        return b"\x1b[M" + bytes([code + 32, column + 32, row + 32])
    raise ValueError(encoding)


class Session:
    """A luban TUI on a PTY, driven a keystroke or report at a time."""

    def __init__(self, name: str) -> None:
        self.port = free_port()
        self.home = tempfile.mkdtemp(prefix=f"luban-mouse-{name}-")
        self.workspace = os.path.join(self.home, "ws")
        os.makedirs(self.workspace, exist_ok=True)
        with open(os.path.join(self.home, "config.json"), "w", encoding="utf-8") as handle:
            json.dump({
                "node": {"name": "mouse-node", "host": "127.0.0.1", "port": 0, "udp_port": 0},
                "model": {"base_url": f"http://127.0.0.1:{self.port}/v1", "api_key": "local",
                          "model": "mock-model", "active": "mock/mock-model", "max_tokens": 2048,
                          "temperature": 0, "timeout": 30},
                "providers": {"mock": {
                    "options": {"baseURL": f"http://127.0.0.1:{self.port}/v1", "apiKey": "local"},
                    "models": {"mock-model": {"name": "Mock Model"}},
                }},
                "max_steps": 2,
            }, handle)
        self.mock = subprocess.Popen(
            ["node", os.path.join(ROOT, "scripts", "mock-model.mjs"), str(self.port)],
            cwd=ROOT, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
        )
        self.master = self.proc = None
        self.out = bytearray()

    def start(self) -> None:
        time.sleep(1.2)
        self.master, slave = pty.openpty()
        fcntl.ioctl(slave, termios.TIOCSWINSZ, struct.pack("HHHH", ROWS, COLS, 0, 0))
        self.proc = subprocess.Popen(
            ["node", os.path.join(ROOT, "dist", "cli.js"), self.workspace, "--yes", "--no-mesh"],
            cwd=self.workspace, stdin=slave, stdout=slave, stderr=slave, close_fds=True,
            env=dict(os.environ, LUBAN_HOME=self.home, TERM="xterm-256color"),
        )
        os.close(slave)
        self.drain(3.0)

    def drain(self, seconds: float) -> None:
        end = time.time() + seconds
        while time.time() < end:
            ready, _, _ = select.select([self.master], [], [], 0.2)
            if not ready:
                continue
            try:
                data = os.read(self.master, 65536)
            except OSError:
                return
            if not data:
                return
            self.out.extend(data)

    def send(self, data: bytes, settle: float = 0.5) -> None:
        os.write(self.master, data)
        self.drain(settle)

    def frames(self) -> str:
        """Everything written back so far, with terminal control noise removed."""
        return ANSI.sub("", OSC.sub("", bytes(self.out).decode("utf-8", "replace")))

    def composer(self) -> str:
        """The composer row of the last frame: `  Auto ❯ <value>`."""
        rows = [line.rstrip() for line in self.frames().splitlines() if "❯" in line]
        return rows[-1] if rows else ""

    def stop(self) -> None:
        try:
            self.send(b"/exit", 0.3)
            self.send(b"\r", 1.0)
        except OSError:
            pass
        if self.proc is not None:
            try:
                self.proc.send_signal(signal.SIGTERM)
            except Exception:
                pass
        try:
            if self.master is not None:
                os.close(self.master)
        except OSError:
            pass
        self.mock.terminate()


def click_places_caret(encoding: str, dump: bool) -> tuple[bool, bool, str, str]:
    """Type, click inside the composer, type a marker. Returns (clean, placed, before, after)."""
    session = Session(encoding)
    try:
        session.start()
        session.send(VALUE.encode(), 0.6)
        before = session.composer()

        # Calibrate: the clicked cell is relative to the value's first character
        # in the rendered row, so the padding and `Auto ❯ ` prefix drop out.
        origin = before.find(VALUE)
        if origin < 0:
            return False, False, before, "(value never rendered)"
        row = ROWS - 2
        column = origin + CLICK_AT + 1  # the terminal counts columns from one
        session.out.clear()
        session.send(report(encoding, column, row), 0.3)
        session.send(report(encoding, column, row, release=True), 0.8)
        after_click = session.composer()
        session.send(b"X", 0.7)
        after = session.composer()
        if dump:
            print(f"--- {encoding}: composer after the click ---")
            print(repr(after_click))
        # A click moves the caret: the row has to come back exactly as it was,
        # with no payload appended and no character eaten.
        clean = after_click == before
        # The marker must land at the clicked cell, not at the end of the value.
        placed = after == f"{before[:origin]}{VALUE[:CLICK_AT]}X{VALUE[CLICK_AT:]}"
        return clean, placed, after_click, after
    finally:
        session.stop()


def wheel_scrolls(encoding: str, steps: int = 8) -> bool:
    """The wheel must page the transcript back, in every encoding."""
    session = Session(encoding)
    try:
        session.start()
        session.send(b"run the checks", 0.5)
        session.send(b"\r", 0.5)
        end = time.time() + 45
        while time.time() < end:
            session.drain(0.5)
            if "任务已完成" in session.frames():
                break
        session.send(b"\x1b[6~" * 12, 0.8)  # PageDown: settle at the newest line
        session.out.clear()
        session.send(report(encoding, 20, 10, button=64), 1.2)  # wheel up
        paged = session.frames()
        return "历史" in paged
    finally:
        session.stop()


def main() -> int:
    wanted = [arg for arg in sys.argv[1:] if not arg.startswith("-")] or ["sgr", "urxvt", "x10"]
    dump = os.environ.get("DUMP") == "1"
    checks: list[tuple[str, bool]] = []
    for encoding in wanted:
        clean, placed, after_click, after = click_places_caret(encoding, dump)
        checks.append((f"{encoding}: click inserts no report payload", clean))
        checks.append((f"{encoding}: click places the caret in the composer", placed))
        print(f"[{encoding:6}] after click={after_click.strip()!r} after typing X={after.strip()!r}")
        if encoding == "x10":
            checks.append(("x10: wheel scrolls the transcript", wheel_scrolls(encoding)))

    failed = [name for name, ok in checks if not ok]
    for name, ok in checks:
        print(f"  {'ok  ' if ok else 'FAIL'} {name}")
    print("missing:", failed or "none")
    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(main())
