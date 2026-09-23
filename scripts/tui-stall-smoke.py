#!/usr/bin/env python3
"""Prove the working line explains a slow, retrying or stalled model call.

The complaint this guards against: "luban 还是会出现长时间的提示 思考中 多少多少段
推理，然后等待上千秒，我都不知道机器人在干什么". A spinner that says nothing is
indistinguishable from a hang, so two runs are scripted against the mock:

  phases  a rate-limited first call, a tool that actually takes time, then a
          paced reasoning + answer stream: every phase and the retry notice
          must appear on the working line.
  stall   the mock accepts the request, sends headers, then goes quiet: the
          idle watchdog must say why it is giving up instead of waiting out the
          ten-minute default in silence.
  truncated  the mock cuts the answer off at the output limit: the run must keep
          the partial text, ask for the rest, and finish instead of failing.

Run it after `npm run build`, in a real PTY (Ink needs a TTY):

    python3 scripts/tui-stall-smoke.py
"""
import fcntl
import json
import os
import pty
import re
import select
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
MOUSE_ECHO = re.compile(r"\x1b\[<\d+;\d+;\d+[Mm]")


def free_port():
    with socket.socket() as sock:
        sock.bind(("127.0.0.1", 0))
        return sock.getsockname()[1]


def wait_for_port(port, timeout=15.0):
    end = time.time() + timeout
    while time.time() < end:
        try:
            with socket.create_connection(("127.0.0.1", port), 0.3):
                return True
        except OSError:
            time.sleep(0.15)
    return False


def run_case(name, model_env, model_config, run_seconds, checks):
    """Drive one real TUI run against the mock and report missing surfaces."""
    port = free_port()
    home = tempfile.mkdtemp(prefix=f"luban-{name}-")
    workspace = os.path.join(home, "ws")
    os.makedirs(workspace, exist_ok=True)
    with open(os.path.join(home, "config.json"), "w", encoding="utf-8") as handle:
        json.dump({
            "node": {"name": f"{name}-node", "host": "127.0.0.1", "port": 0, "udp_port": 0},
            "model": dict({
                "base_url": f"http://127.0.0.1:{port}/v1", "api_key": "local", "model": "mock-model",
                "active": "mock/mock-model", "max_tokens": 2048, "temperature": 0, "timeout": 30,
            }, **model_config),
            "providers": {"mock": {"options": {"baseURL": f"http://127.0.0.1:{port}/v1", "apiKey": "local"},
                                   "models": {"mock-model": {"name": "Mock Model"}}}},
            "max_steps": 12,
        }, handle)

    mock = subprocess.Popen(
        ["node", os.path.join(ROOT, "scripts", "mock-model.mjs"), str(port)],
        cwd=ROOT, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
        env=dict(os.environ, MOCK_TOOL="bash", MOCK_TOOL_STEPS="1", **model_env),
    )
    if not wait_for_port(port):
        mock.terminate()
        raise SystemExit(f"{name}: mock model never listened")

    master, slave = pty.openpty()
    fcntl.ioctl(slave, termios.TIOCSWINSZ, struct.pack("HHHH", 34, 150, 0, 0))
    proc = subprocess.Popen(
        ["node", os.path.join(ROOT, "dist", "cli.js"), workspace],
        stdin=slave, stdout=slave, stderr=slave, close_fds=True,
        # Approval is a separate flow; these runs are about waiting on the model.
        env=dict(os.environ, LUBAN_HOME=home, TERM="xterm-256color", LUBAN_ALLOW_TOOLS="1"),
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

    try:
        drain(3)
        os.write(master, "运行一次检查，然后总结结果。".encode("utf-8"))
        drain(0.8)
        os.write(master, b"\r")
        drain(run_seconds)
    finally:
        frames = MOUSE_ECHO.sub("", OSC.sub("", ANSI.sub("", bytes(out).decode("utf-8", "replace"))))
        proc.terminate()
        mock.terminate()
        try:
            os.close(master)
        except OSError:
            pass

    missing = [label for label, pattern in checks if not pattern.search(frames)]
    live = [line for line in frames.splitlines()
            if re.search(r"等待模型响应|推理中|生成回复|执行工具", line)]
    print(f"=== {name}: {len(out)} bytes, missing: {missing or 'none'}")
    for line in live[:2] + live[-8:]:
        print("   ", line.strip()[:150])
    if missing:
        # The last screen is what a human would be looking at.
        tail = [line.rstrip() for line in frames.splitlines() if line.strip()][-14:]
        print("--- screen tail ---")
        for line in tail:
            print("   ", line[:150])
    return missing


failures = []

failures += run_case(
    "phases",
    # One rate-limited call, a tool that takes long enough to be seen, then a
    # paced reasoning + answer stream.
    {"MOCK_TOOL_SLEEP_MS": "1500", "MOCK_THINKING": "1", "MOCK_FAIL_TIMES": "1", "MOCK_PACE_MS": "120"},
    {"thinking_timeout": 60, "max_retries": 3},
    16,
    [
        ("phase: waiting", re.compile(r"等待模型响应")),
        ("phase: tool", re.compile(r"执行工具")),
        ("phase: reasoning", re.compile(r"推理中")),
        ("phase: answering", re.compile(r"生成回复")),
        ("tool summary on the line", re.compile(r"执行工具 #\d+ sleep 1\.50")),
        ("model call counter", re.compile(r"#\d+")),
        ("step timer", re.compile(r"本步 \d+s · 总 \d+s")),
        ("tool timer", re.compile(r"已运行 \d+s · 总 \d+s")),
        # A retry must say why and when, instead of looking like slow thinking.
        ("retry notice", re.compile(r"HTTP 429.*重试（第 2/4 次）")),
    ],
)

failures += run_case(
    "stall",
    # Headers arrive, then nothing: the shape that used to look like thinking.
    {"MOCK_SILENCE_MS": "2500", "MOCK_SILENCE_TIMES": "1"},
    {"thinking_timeout": 2, "max_retries": 3},
    10,
    [
        ("idle notice", re.compile(r"模型已 2s 没有任何输出，已中断本次请求")),
    ],
)

# The old line fell back to a bare fragment counter once reasoning ended, which
# is what made a stalled run unreadable. The silence countdown itself is a pure
# function of the clock, covered by src/ui/thinking-line.test.tsx.
failures += run_case(
    "truncated",
    # A provider cap, not a luban budget: repeating the request cannot help.
    {"MOCK_TRUNCATE_TIMES": "1", "MOCK_PACE_MS": "40"},
    {"thinking_timeout": 60, "max_retries": 1},
    14,
    [
        ("kept and continued", re.compile(r"模型输出被输出上限截断")),
        ("run completes", re.compile(r"✓ 任务已完成")),
    ],
)
# Completing is the point: one truncated answer used to end the whole run, so the
# completion check above is what proves the partial text was kept and continued.

print("missing:", failures or "none")
if failures:
    sys.exit(1)
