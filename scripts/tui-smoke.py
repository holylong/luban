#!/usr/bin/env python3
"""Launch the built TUI in a real PTY and assert the new panels render.

Ink needs a TTY, so this cannot run through a pipe. Run it after `npm run build`:

    python3 scripts/tui-smoke.py

Exits non-zero when an expected surface never appears, so it can gate a release
without a human watching a terminal.
"""
import fcntl
import os
import pty
import re
import select
import struct
import subprocess
import sys
import tempfile
import termios
import time

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
ANSI = re.compile(r"\x1b\[[0-9;?]*[a-zA-Z]")
OSC = re.compile(r"\x1b\][^\x07]*\x07")

master, slave = pty.openpty()
fcntl.ioctl(slave, termios.TIOCSWINSZ, struct.pack("HHHH", 40, 140, 0, 0))

home = tempfile.mkdtemp(prefix="luban-tui-")
workspace = os.path.join(home, "ws")
os.makedirs(workspace, exist_ok=True)

env = dict(os.environ, LUBAN_HOME=home, TERM="xterm-256color")
proc = subprocess.Popen(
    ["node", os.path.join(ROOT, "dist", "cli.js"), workspace],
    stdin=slave, stdout=slave, stderr=slave, close_fds=True, env=env,
)
os.close(slave)

out = bytearray()


def drain(seconds):
    end = time.time() + seconds
    while time.time() < end:
        ready, _, _ = select.select([master], [], [], 0.2)
        if not ready:
            continue
        try:
            data = os.read(master, 65536)
        except OSError:
            return
        if not data:
            return
        out.extend(data)


def send(text, settle=0.9):
    os.write(master, text)
    drain(settle)


try:
    drain(3)
    # Type and submit separately: a PTY delivers one chunk at a time and Ink
    # needs a render pass between the keystrokes and the Return.
    send(b"/verify", 0.8)
    send(b"\r", 1.2)
    send(b"\x1b", 0.6)       # Esc closes the verification panel
    send(b"/plan", 0.6)
    send(b"\r", 1.0)
    send(b"/details", 0.6)
    send(b"\r", 1.0)
    send(b"/exit", 0.5)
    send(b"\r", 1.5)
finally:
    try:
        proc.terminate()
    except Exception:
        pass
    try:
        os.close(master)
    except OSError:
        pass

raw = bytes(out).decode("utf-8", "replace")
clean = OSC.sub("", ANSI.sub("", raw))

checks = [
    ("startup banner", re.compile(r"luban", re.I)),
    ("verification panel", re.compile(r"验证记录")),
    ("verification empty state", re.compile(r"还没有记录验证|record_verification")),
    ("command hints", re.compile(r"/plan")),
]
missing = [name for name, pattern in checks if not pattern.search(clean)]

lines = [line for line in clean.splitlines() if line.strip()]
print("bytes:", len(out))
print("missing:", missing or "none")
print("--- tail ---")
print("\n".join(lines[-18:]))

if missing:
    sys.exit(1)
