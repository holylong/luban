#!/usr/bin/env python3
"""Paste multi-line text into the built TUI and check the composer behaves.

The box must show the cursor line and a bounded number of rows, must not submit
the paste, and must send the whole block when Enter is finally pressed.

    python3 scripts/tui-input-smoke.py [cols] [rows]

Needs `npm run build` first. Exits non-zero when a paste is lost or clipped.
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
MOUSE_ECHO = re.compile(r"\^\[\[<\d+;\d+;\d+[mM]")
COLS = int(sys.argv[1]) if len(sys.argv) > 1 else 100
ROWS = int(sys.argv[2]) if len(sys.argv) > 2 else 24
LINES = 40


def free_port():
    with socket.socket() as sock:
        sock.bind(("127.0.0.1", 0))
        return sock.getsockname()[1]


port = free_port()
home = tempfile.mkdtemp(prefix="luban-input-")
workspace = os.path.join(home, "ws")
os.makedirs(workspace, exist_ok=True)
with open(os.path.join(home, "config.json"), "w", encoding="utf-8") as handle:
    json.dump({
        "node": {"name": "input-node", "host": "127.0.0.1", "port": 0, "udp_port": 0},
        "model": {
            "base_url": f"http://127.0.0.1:{port}/v1", "api_key": "local", "model": "mock-model",
            "active": "mock/mock-model", "max_tokens": 2048, "temperature": 0, "timeout": 30,
        },
        "providers": {"mock": {"options": {"baseURL": f"http://127.0.0.1:{port}/v1", "apiKey": "local"},
                               "models": {"mock-model": {"name": "Mock Model"}}}},
        "max_steps": 4,
    }, handle)

mock = subprocess.Popen(
    ["node", os.path.join(ROOT, "scripts", "mock-model.mjs"), str(port)],
    cwd=ROOT, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
    env=dict(os.environ, MOCK_TOOL_STEPS="1", MOCK_DELAY_MS="200"),
)

master = None
proc = None
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


def screen():
    text = bytes(out).decode("utf-8", "replace")
    return MOUSE_ECHO.sub("", OSC.sub("", ANSI.sub("", text)))


def wait_until(predicate, timeout):
    end = time.time() + timeout
    while time.time() < end:
        drain(0.4)
        if predicate(screen()):
            return True
    return False


try:
    for _ in range(60):
        try:
            socket.create_connection(("127.0.0.1", port), 0.3).close()
            break
        except OSError:
            time.sleep(0.15)

    master, slave = pty.openpty()
    fcntl.ioctl(slave, termios.TIOCSWINSZ, struct.pack("HHHH", ROWS, COLS, 0, 0))
    proc = subprocess.Popen(
        ["node", os.path.join(ROOT, "dist", "cli.js"), workspace, "--yes", "--no-mesh"],
        cwd=workspace, stdin=slave, stdout=slave, stderr=slave, close_fds=True,
        env=dict(os.environ, LUBAN_HOME=home, TERM="xterm-256color"),
    )
    os.close(slave)

    drain(3)
    out.clear()
    paste = "\r\n".join(f"paste-line-{index:02d}" for index in range(1, LINES + 1))
    os.write(master, paste.encode())
    drain(1.5)
    after_paste = screen()

    # The cursor sits on the last line, so the tail must be on screen...
    tail_visible = f"paste-line-{LINES:02d}" in after_paste
    # ...and with a bounded box the first line is scrolled out of view.
    head_hidden = "paste-line-01" not in after_paste
    counted = re.search(r"⏎ (\d+)行", after_paste) is not None
    not_submitted = "任务已完成" not in after_paste and "##" not in after_paste

    # Escape clears nothing, so Enter now submits the whole block.
    os.write(master, b"\r")
    submitted = wait_until(lambda text: "任务已完成" in text or "TOOL ERROR" in text, 45)
    drain(1.0)
    after_submit = screen()
    whole_block_sent = f"paste-line-01" in after_submit and f"paste-line-{LINES:02d}" in after_submit

    def clear_composer():
        """Empty the box so each block below starts from a known state."""
        for _ in range(80):
            os.write(master, b"\x7f")
        drain(0.6)

    # Backspace: most terminals send \x7f, which Ink names `delete`, so this is
    # the regression that made the key look dead. Capture the delta only.
    clear_composer()
    out.clear()
    os.write(master, b"backspace-probe")
    drain(0.5)
    typed_probe = "backspace-probe" in screen()

    out.clear()
    os.write(master, b"\x7f")
    drain(0.8)
    after_backspace = screen()
    backspace_works = "backspace-prob" in after_backspace and "backspace-probe" not in after_backspace

    # Ctrl+H is the other byte terminals use for Backspace.
    out.clear()
    os.write(master, b"\x08")
    drain(0.8)
    after_ctrl_h = screen()
    ctrl_h_works = "backspace-pro" in after_ctrl_h and "backspace-prob" not in after_ctrl_h

    # The Delete key (ESC [ 3 ~) also removes the previous character: Ink gives
    # it the same flag as Backspace, so it cannot be told apart.
    out.clear()                            # measure only this keypress
    os.write(master, b"\x1b[3~")
    drain(0.8)
    after_delete = screen()
    delete_works = "backspace-pr" in after_delete and "backspace-pro" not in after_delete
    clear_composer()

    # A typed prompt submits, then Up recalls it into the empty box.
    out.clear()
    os.write(master, b"history-probe")
    drain(0.5)
    os.write(master, b"\r")
    submitted2 = wait_until(lambda text: "history-probe" in text, 25)
    drain(1.0)
    clear_composer()
    out.clear()
    os.write(master, b"\x1b[A")
    drain(1.0)
    history_recalled = "history-probe" in screen()
    clear_composer()

    # Ctrl+J carries a bare linefeed: it must open a second line, not submit.
    out.clear()
    os.write(master, b"alpha")
    drain(0.3)
    os.write(master, b"\n")
    drain(0.3)
    os.write(master, b"beta")
    drain(0.8)
    multiline_typed = re.search(r"⏎ 2行", screen()) is not None
    clear_composer()

    checks = [
        ("typing into the composer works", typed_probe),
        ("backspace deletes the previous character", backspace_works),
        ("Ctrl+H also deletes the previous character", ctrl_h_works),
        ("the delete key is not left dead", delete_works),
        ("paste is held in the composer, not submitted", not_submitted),
        ("cursor line is visible after a tall paste", tail_visible),
        ("composer is bounded so the head scrolls away", head_hidden),
        ("composer reports the line count", counted),
        ("enter submits the paste", submitted),
        ("the whole block reaches the transcript", whole_block_sent),
        ("a typed prompt submits", submitted2),
        ("up recalls the previous input", history_recalled),
        ("Ctrl+J opens a second line instead of submitting", multiline_typed),
    ]
    missing = [name for name, ok in checks if not ok]

    if os.environ.get("DUMP"):
        print("--- frame after paste ---")
        for line in [l.rstrip() for l in after_paste.splitlines() if l.strip()][-(ROWS + 2):]:
            print(f"|{line[:COLS]}|")
    print(f"terminal: {COLS}x{ROWS}; pasted {LINES} lines")
    print("missing:", missing or "none")
    if missing:
        print("--- frame after paste ---")
        for line in [l.rstrip() for l in after_paste.splitlines() if l.strip()][-ROWS:]:
            print(f"|{line[:COLS]}|")
    sys.exit(1 if missing else 0)
finally:
    if proc is not None:
        try:
            proc.send_signal(signal.SIGTERM)
        except Exception:
            pass
    try:
        if master is not None:
            os.close(master)
    except OSError:
        pass
    mock.terminate()
