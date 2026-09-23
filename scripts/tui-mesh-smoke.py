#!/usr/bin/env python3
"""Prove both mesh terminals show a delegated task and its work.

Two real TUI nodes talk over the LAN mesh in this test. Both terminals show the same
detail it shows for local work — the instruction, the plan, the tool call, the
phase it is in, and the outcome — instead of a single "last log line" in the
corner panel.

Run it after `npm run build`, in a real PTY (Ink needs a TTY):

    python3 scripts/tui-mesh-smoke.py
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
NODE = "tui-node"
PEER = "peer-node"
INSTRUCTION = "统计仓库里的测试数量"


def free_port():
    with socket.socket() as sock:
        sock.bind(("127.0.0.1", 0))
        return sock.getsockname()[1]


def wait_for_port(port, timeout=20.0):
    end = time.time() + timeout
    while time.time() < end:
        try:
            with socket.create_connection(("127.0.0.1", port), 0.3):
                return True
        except OSError:
            time.sleep(0.15)
    return False


def write_config(path, name, port, udp_port, peer, peer_port, peer_udp, model_port, timeout_ms):
    with open(path, "w", encoding="utf-8") as handle:
        json.dump({
            "node": {"name": name, "host": "127.0.0.1", "port": port, "udp_port": udp_port},
            # Contacts are top level, which is where `luban add-contact` writes them.
            "contacts": [{"name": peer, "host": "127.0.0.1", "port": peer_port, "udp_port": peer_udp}],
            "model": {
                "base_url": f"http://127.0.0.1:{model_port}/v1", "api_key": "local", "model": "mock-model",
                "active": "mock/mock-model", "max_tokens": 2048, "temperature": 0,
                "timeout": 30, "thinking_timeout": 30, "max_retries": 1,
            },
            "providers": {"mock": {"options": {"baseURL": f"http://127.0.0.1:{model_port}/v1", "apiKey": "local"},
                                   "models": {"mock-model": {"name": "Mock Model"}}}},
            "permissions": {"mode": "allow"},
            "max_steps": 12,
            "planning": "auto",
        }, handle)


model_port_a = free_port()
model_port_b = free_port()
port_a, udp_a = free_port(), free_port()
port_b, udp_b = free_port(), free_port()

home_a = tempfile.mkdtemp(prefix="luban-mesh-a-")
home_b = tempfile.mkdtemp(prefix="luban-mesh-b-")
# One workspace on both sides: the mesh resolves a job's project by name, and a
# shared name is what makes the peer's task land here.
workspace = os.path.join(home_a, "shared-project")
os.makedirs(workspace, exist_ok=True)
with open(os.path.join(workspace, "README.md"), "w", encoding="utf-8") as handle:
    handle.write("# shared project\n")

write_config(os.path.join(home_a, "config.json"), NODE, port_a, udp_a, PEER, port_b, udp_b, model_port_a, 30)
write_config(os.path.join(home_b, "config.json"), PEER, port_b, udp_b, NODE, port_a, udp_a, model_port_b, 30)

# The receiving node runs a normal task: plan, one shell call, a paced answer.
mock_a = subprocess.Popen(
    ["node", os.path.join(ROOT, "scripts", "mock-model.mjs"), str(model_port_a)],
    cwd=ROOT, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
    env=dict(os.environ, MOCK_PLAN="1", MOCK_TOOL="bash", MOCK_TOOL_STEPS="2",
             MOCK_THINKING="1", MOCK_PACE_MS="60", MOCK_TOOL_SLEEP_MS="800"),
)
# The delegating node sends a chat and hands the task over via TUI commands.
mock_b = subprocess.Popen(
    ["node", os.path.join(ROOT, "scripts", "mock-model.mjs"), str(model_port_b)],
    cwd=ROOT, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
    env=dict(os.environ),
)
for port in (model_port_a, model_port_b):
    if not wait_for_port(port):
        raise SystemExit("mock model never listened")

master, slave = pty.openpty()
fcntl.ioctl(slave, termios.TIOCSWINSZ, struct.pack("HHHH", 40, 150, 0, 0))
node = subprocess.Popen(
    ["node", os.path.join(ROOT, "dist", "cli.js"), workspace, "-y"],
    stdin=slave, stdout=slave, stderr=slave, close_fds=True,
    env=dict(os.environ, LUBAN_HOME=home_a, TERM="xterm-256color"),
)
os.close(slave)
peer_master, peer_slave = pty.openpty()
fcntl.ioctl(peer_slave, termios.TIOCSWINSZ, struct.pack("HHHH", 40, 150, 0, 0))
peer = None
out = bytearray()
peer_out = bytearray()


def drain(seconds):
    end = time.time() + seconds
    while time.time() < end:
        ready, _, _ = select.select([master, peer_master], [], [], 0.2)
        if not ready:
            continue
        for fd in ready:
            try:
                data = os.read(fd, 65536)
            except OSError:
                continue
            if data:
                (out if fd == master else peer_out).extend(data)


def enter(command):
    # Ink treats a whole command plus CR in one PTY read as pasted text.
    os.write(peer_master, command.encode())
    drain(0.5)
    os.write(peer_master, b"\r")


try:
    drain(4)
    if not wait_for_port(port_a):
        raise SystemExit("the TUI node never listened on the mesh port")
    # A second real terminal sends a message and delegates the task.
    peer = subprocess.Popen(
        ["node", os.path.join(ROOT, "dist", "cli.js"), workspace, "-y"],
        cwd=ROOT, stdin=peer_slave, stdout=peer_slave, stderr=peer_slave, close_fds=True,
        env=dict(os.environ, LUBAN_HOME=home_b, TERM="xterm-256color"),
    )
    os.close(peer_slave)
    drain(4)
    if not wait_for_port(port_b):
        raise SystemExit("the delegating TUI never listened on the mesh port")
    enter(f"/message {NODE} hello from peer")
    drain(2)
    enter(f"/handoff {NODE} {INSTRUCTION}")
    drain(35)
finally:
    frames = MOUSE_ECHO.sub("", OSC.sub("", ANSI.sub("", bytes(out).decode("utf-8", "replace"))))
    peer_frames = MOUSE_ECHO.sub("", OSC.sub("", ANSI.sub("", bytes(peer_out).decode("utf-8", "replace"))))
    node.terminate()
    if peer:
        peer.terminate()
    mock_a.terminate()
    mock_b.terminate()
    try:
        os.close(master)
    except OSError:
        pass
    try:
        os.close(peer_master)
    except OSError:
        pass

checks = [
    # The instruction and its origin, as a block in the same stream as local work.
    ("inbound job header", re.compile(r"📥 来自 peer-node · " + re.escape(INSTRUCTION))),
    # The plan the remote job published reaches the plan panel.
    ("remote task plan", re.compile(r"Task plan · 📥 peer-node")),
    ("plan steps", re.compile(r"检查仓库")),
    # The tool the peer ran, with its command, is a real execution row.
    ("remote tool call", re.compile(r"Shell")),
    ("tool command", re.compile(r"sleep 0\.80; printf 'line-\d-0")),
    # The phase line names the peer while the job is in flight.
    ("remote phase line", re.compile(r"📥 peer-node (等待模型响应|推理中|生成回复|执行工具)")),
    # And the outcome, with the model round trips the peer spent.
    ("remote outcome", re.compile(r"✓ 任务完成 · \d+ 次模型调用")),
]
missing = [label for label, pattern in checks if not pattern.search(frames)]
peer_checks = [
    ("sender chat", re.compile(r"📤 发给 tui-node")),
    ("sender job header", re.compile(r"📤 已交给 tui-node · " + re.escape(INSTRUCTION))),
    ("sender tool call", re.compile(r"Shell")),
    ("sender tool command", re.compile(r"sleep 0\.80; printf 'line-\d-0")),
    ("sender outcome", re.compile(r"✓ 任务完成 · \d+ 次模型调用")),
]
missing.extend(label for label, pattern in peer_checks if not pattern.search(peer_frames))
if "📨 来自 peer-node" not in frames or "hello from peer" not in frames:
    missing.append("receiver chat")

lines = [line for line in frames.splitlines() if line.strip()]
print("bytes:", len(out), "peer bytes:", len(peer_out))
print("missing:", missing or "none")
print("--- remote rows seen ---")
for line in lines[-80:]:
    if re.search(r"📥|任务完成|Shell|检查仓库|Task plan|等待模型响应|推理中|执行工具|生成回复|printf|sleep", line):
        print("   ", line.strip()[:150])

if missing:
    print("--- peer terminal tail ---")
    print("\n".join(peer_frames.splitlines()[-25:]))
    sys.exit(1)
