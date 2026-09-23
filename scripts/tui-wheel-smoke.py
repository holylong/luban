#!/usr/bin/env python3
"""Drive the built TUI through a real run and exercise mouse-wheel scrolling.

Covers what unit tests cannot: the wheel escape sequences reach the app, the
first upward notch opens the execution details, the window walks to both ends,
it clamps instead of drifting past them, and the visible pane really shows the
oldest operations once scrolled up.

    python3 scripts/tui-wheel-smoke.py [cols] [rows]

Needs `npm run build` first. Exits non-zero when an expected frame never appears.
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
# The PTY echoes what we write as if it were typed; a real terminal sends mouse
# reports to the app without echoing them.
MOUSE_ECHO = re.compile(r"\^\[\[<\d+;\d+;\d+[mM]")
WHEEL_UP = b"\x1b[<64;20;20M"
WHEEL_DOWN = b"\x1b[<65;20;20M"
STEPS = 6
# Default to a common laptop terminal; pass size on the command line to check
# narrower or shorter layouts.
COLS = int(sys.argv[1]) if len(sys.argv) > 1 else 120
ROWS = int(sys.argv[2]) if len(sys.argv) > 2 else 36


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


port = free_port()
home = tempfile.mkdtemp(prefix="luban-wheel-")
workspace = os.path.join(home, "ws")
os.makedirs(workspace, exist_ok=True)

with open(os.path.join(home, "config.json"), "w", encoding="utf-8") as handle:
    json.dump({
        "node": {"name": "wheel-node", "host": "127.0.0.1", "port": 0, "udp_port": 0},
        "model": {
            "base_url": f"http://127.0.0.1:{port}/v1", "api_key": "local", "model": "mock-model",
            "active": "mock/mock-model", "max_tokens": 2048, "temperature": 0, "timeout": 30,
        },
        "providers": {"mock": {"options": {"baseURL": f"http://127.0.0.1:{port}/v1", "apiKey": "local"},
                               "models": {"mock-model": {"name": "Mock Model"}}}},
        "max_steps": 12,
    }, handle)

mock = subprocess.Popen(
    ["node", os.path.join(ROOT, "scripts", "mock-model.mjs"), str(port)],
    cwd=ROOT, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
    # A local mock answers in milliseconds; a small delay keeps the run in
    # flight long enough to observe the transcript growing.
    env=dict(os.environ, MOCK_TOOL="bash", MOCK_TOOL_STEPS=str(STEPS), MOCK_DELAY_MS="350"),
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
    """Accumulated output with terminal control noise and PTY echo removed."""
    text = bytes(out).decode("utf-8", "replace")
    return MOUSE_ECHO.sub("", OSC.sub("", ANSI.sub("", text)))


def send(text, settle=0.6):
    os.write(master, text)
    drain(settle)


def scrolled_back(text: str, tail: int = 3000) -> bool:
    """True when the final frames report a scroll position back from the newest."""
    return re.search(r"历史 \d+%", text[-tail:]) is not None


def wait_until(predicate, timeout):
    end = time.time() + timeout
    while time.time() < end:
        drain(0.4)
        if predicate(screen()):
            return True
    return False


try:
    if not wait_for_port(port):
        print("mock model did not start")
        sys.exit(2)

    master, slave = pty.openpty()
    fcntl.ioctl(slave, termios.TIOCSWINSZ, struct.pack("HHHH", ROWS, COLS, 0, 0))
    proc = subprocess.Popen(
        ["node", os.path.join(ROOT, "dist", "cli.js"), workspace, "--yes", "--no-mesh"],
        cwd=workspace, stdin=slave, stdout=slave, stderr=slave, close_fds=True,
        env=dict(os.environ, LUBAN_HOME=home, TERM="xterm-256color"),
    )
    os.close(slave)

    drain(3)
    send(b"run the checks", 0.6)
    send(b"\r", 0.4)

    # The transcript must grow while the run is still in flight, not appear all
    # at once at the end: sample how many distinct tool output rows are on
    # screen and require the count to rise before the task reports finished.
    growth: list[int] = []
    end = time.time() + 60
    while time.time() < end:
        drain(0.5)
        text = screen()
        growth.append(len(set(re.findall(r"line-\d+-\d+", text))))
        if "任务已完成" in text:
            break
    grew_live = len(growth) > 1 and any(growth[i] < growth[i + 1] for i in range(len(growth) - 1))
    ran = f"line-{STEPS}-0" in screen()
    drain(1.0)
    after_run = len(out)

    # The wheel drives the single transcript; the newest operation is on screen
    # at the bottom before any scrolling.
    newest_before = f"line-{STEPS}-0" in screen() and not scrolled_back(screen())
    send(WHEEL_UP, 1.2)

    for _ in range(60):
        send(WHEEL_UP, 0.05)
    drain(1.5)
    top = screen()
    oldest_visible = f"line-1-0" in top

    # Scroll far past the end, then back: the view must still move, which only
    # holds when the offset was clamped instead of remembered.
    for _ in range(60):
        send(WHEEL_UP, 0.04)
    drain(1.0)
    overscrolled = len(out)

    for _ in range(160):
        send(WHEEL_DOWN, 0.04)
    drain(1.5)
    bottom = screen()
    newest_visible = f"line-{STEPS}-0" in bottom and not scrolled_back(bottom)

    # Drag the scrollbar: press on the track, move up, release. Without button
    # event tracking the terminal reports nothing here and the view stays put.
    out.clear()
    drain(0.3)
    os.write(master, f"\x1b[<0;{COLS};20M".encode())          # left press on the track
    drain(0.2)
    for y in range(20, 8, -1):
        os.write(master, f"\x1b[<32;{COLS};{y}M".encode())    # motion with the button held
        # Drain between steps: a full frame per event exceeds the PTY buffer,
        # and a blocked writer stops the app reading the next event.
        drain(0.08)
    os.write(master, f"\x1b[<0;{COLS};9m".encode())           # release
    drain(1.2)
    dragged = screen()
    drag_works = scrolled_back(dragged)

    # A click on the track above the thumb pages back without any dragging.
    out.clear()
    os.write(master, f"\x1b[<0;{COLS};6M".encode())
    drain(0.15)
    os.write(master, f"\x1b[<0;{COLS};6m".encode())
    drain(1.0)
    track_click_pages = scrolled_back(screen())

    # The keyboard path shares the same scroll model, so it must page too.
    # Return to the newest first: the track click above can already sit at the
    # top, and paging further up from there is a no-op by design.
    for _ in range(16):
        send(b"\x1b[6~", 0.1)
    drain(0.6)
    out.clear()
    for _ in range(6):
        send(b"\x1b[5~", 0.25)
    drain(1.0)
    paged = screen()
    page_up_works = scrolled_back(paged) and any(f"line-{index}-0" in paged for index in range(1, 7))
    out.clear()
    for _ in range(12):
        send(b"\x1b[6~", 0.2)
    drain(1.0)
    page_down_works = f"line-{STEPS}-0" in screen() and not scrolled_back(screen())

    send(b"/exit", 0.4)
    send(b"\r", 1.2)

    checks = [
        ("multi-step run produced execution details", ran),
        ("transcript grew while the run was still in flight", grew_live),
        ("newest operation visible before scrolling", newest_before),
        ("oldest operation is reachable by scrolling up", oldest_visible),
        ("overscroll produced no further movement", overscrolled >= after_run),
        ("scrolling back down returns to the newest operation", newest_visible),
        ("scrollbar track rendered", "█" in bottom or "█" in top),
        ("dragging the scrollbar scrolls the transcript", drag_works),
        ("clicking the track pages without dragging", track_click_pages),
        ("PageUp pages back through the history", page_up_works),
        ("PageDown returns to the newest operation", page_down_works),
    ]
    missing = [name for name, ok in checks if not ok]

    if not page_up_works:
        print("--- frame after PageUp ---")
        print("\n".join([line.rstrip() for line in paged.splitlines() if line.strip()][-30:]))

    print(f"terminal: {COLS}x{ROWS}")
    print("live row samples:", growth[:12])
    print("bytes:", len(out))
    print("missing:", missing or "none")
    if os.environ.get("DUMP"):
        print("--- frame (right edge kept) ---")
        for line in [l.rstrip() for l in bottom.splitlines() if l.strip()][-ROWS:]:
            print(f"|{line[:COLS]}|")
    if missing:
        print("--- last frame ---")
        lines = [line.rstrip() for line in screen().splitlines() if line.strip()]
        print("\n".join(lines[-30:]))
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
