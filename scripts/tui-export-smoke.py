#!/usr/bin/env python3
"""Run a real edit through the TUI, then /export and inspect the Markdown.

Asserts the exported file carries the concrete mutation — path, added/removed
counts, line numbers and the before/after line content — rather than only a
summary of the conversation.

    python3 scripts/tui-export-smoke.py

Needs `npm run build` first. Exits non-zero when the export is incomplete.
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

BEFORE = "# demo\n\nhello world\n"
AFTER = "# demo\n\nhello world\n\nAdded by the mock model run.\n"


def free_port():
    with socket.socket() as sock:
        sock.bind(("127.0.0.1", 0))
        return sock.getsockname()[1]


port = free_port()
home = tempfile.mkdtemp(prefix="luban-export-")
workspace = os.path.join(home, "ws")
os.makedirs(workspace, exist_ok=True)
with open(os.path.join(workspace, "README.md"), "w", encoding="utf-8") as handle:
    handle.write(BEFORE)

with open(os.path.join(home, "config.json"), "w", encoding="utf-8") as handle:
    json.dump({
        "node": {"name": "export-node", "host": "127.0.0.1", "port": 0, "udp_port": 0},
        "model": {
            "base_url": f"http://127.0.0.1:{port}/v1", "api_key": "local", "model": "mock-model",
            "active": "mock/mock-model", "max_tokens": 2048, "temperature": 0, "timeout": 30,
        },
        "providers": {"mock": {"options": {"baseURL": f"http://127.0.0.1:{port}/v1", "apiKey": "local"},
                               "models": {"mock-model": {"name": "Mock Model"}}}},
        "max_steps": 8,
    }, handle)

mock = subprocess.Popen(
    ["node", os.path.join(ROOT, "scripts", "mock-model.mjs"), str(port)],
    cwd=ROOT, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
    env=dict(os.environ, MOCK_TOOL="write_file", MOCK_TOOL_STEPS="1"),
)

export_path = os.path.join(home, "export.md")
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
    fcntl.ioctl(slave, termios.TIOCSWINSZ, struct.pack("HHHH", 40, 140, 0, 0))
    proc = subprocess.Popen(
        ["node", os.path.join(ROOT, "dist", "cli.js"), workspace, "--yes", "--no-mesh"],
        cwd=workspace, stdin=slave, stdout=slave, stderr=slave, close_fds=True,
        env=dict(os.environ, LUBAN_HOME=home, TERM="xterm-256color"),
    )
    os.close(slave)

    drain(3)
    os.write(master, b"update the readme")
    drain(0.6)
    os.write(master, b"\r")
    finished = wait_until(lambda text: "任务已完成" in text or "Added by the mock model run" in text, 60)
    drain(1.0)

    os.write(master, f"/export {export_path}".encode())
    drain(0.6)
    os.write(master, b"\r")
    wait_until(lambda text: "已导出" in text, 20)
    drain(0.8)
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

if not os.path.exists(export_path):
    print("no export written to", export_path)
    print(screen()[-1500:])
    sys.exit(1)

markdown = open(export_path, encoding="utf-8").read()
checks = [
    ("run completed", finished),
    ("file path is listed", "README.md" in markdown),
    ("added/removed counts are listed", re.search(r"文件修改: 1 个文件 · \+\d+ −\d+", markdown) is not None),
    ("the summary table carries per-file counts",
     re.search(r"\|\s*`README\.md`\s*\|\s*write_file\s*\|\s*\+\d+\s*\|\s*−\d+\s*\|", markdown) is not None),
    ("a change summary table is present", "## 修改记录" in markdown and "| 文件 |" in markdown),
    ("added line content is present", "Added by the mock model run." in markdown),
    ("line numbers survive", re.search(r"^\s*\d+ \+Added by the mock model run\.$", markdown, re.M) is not None),
    ("the diff is fenced for rendering", "```diff" in markdown),
    ("the conversation is still there", "## 👤 用户" in markdown),
]
missing = [name for name, ok in checks if not ok]

print("export bytes:", len(markdown))
print("missing:", missing or "none")
print("--- export ---")
print(markdown)
sys.exit(1 if missing else 0)
