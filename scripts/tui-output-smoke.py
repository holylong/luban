#!/usr/bin/env python3
"""Replay real PTY output and detect duplicate composer/status rows.

Requires npm run build and Python pyte (python3 -m pip install pyte).
Run: python3 scripts/tui-output-smoke.py
A real history database failure is triggered while the model is streaming.
No paid model calls or user configuration are used.
"""
import codecs
import fcntl
import json
import os
from pathlib import Path
import pty
import select
import signal
import socket
import struct
import subprocess
import tempfile
import termios
import time

import pyte

ROOT = Path(__file__).resolve().parent.parent


def run(columns, rows):
    with tempfile.TemporaryDirectory(prefix='luban-output-') as home:
        base = Path(home)
        workspace = base / 'workspace'
        workspace.mkdir()
        with socket.socket() as sock:
            sock.bind(('127.0.0.1', 0))
            port = sock.getsockname()[1]
        (base / 'config.json').write_text(json.dumps({
            'model': {'active': 'mock/mock-model', 'timeout': 30},
            'providers': {'mock': {'options': {
                'baseURL': f'http://127.0.0.1:{port}/v1', 'apiKey': 'local',
            }, 'models': {'mock-model': {'name': 'Mock Model'}}}},
            'max_steps': 8,
        }))
        fixture = base / 'warning.mjs'
        history_url = json.dumps((ROOT / 'dist/core/session-history.js').as_uri())
        fixture.write_text(
            "import { existsSync, writeFileSync } from 'node:fs';\n"
            "import { join } from 'node:path';\n"
            "const home = process.env.LUBAN_HOME;\n"
            "const timer = setInterval(async () => {\n"
            "  if (!existsSync(join(home, 'trigger'))) return;\n"
            "  clearInterval(timer);\n"
            f"  const {{ SessionHistory }} = await import({history_url});\n"
            "  const directory = join(home, 'history-file');\n"
            "  writeFileSync(directory, 'not a directory');\n"
            "  SessionHistory.open({ enabled: true, directory, maxMessagesPerSession: 0 }, home);\n"
            "  writeFileSync(join(home, 'warning-done'), 'done');\n"
            "}, 25);\n"
            "timer.unref();\n"
        )
        env = dict(os.environ, LUBAN_HOME=home, TERM='xterm-256color',
                   FORCE_COLOR='3', COLORTERM='truecolor')
        env.pop('CI', None)
        mock = subprocess.Popen(
            ['node', str(ROOT / 'scripts/mock-model.mjs'), str(port)],
            stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
            env=dict(env, MOCK_DELAY_MS='300', MOCK_TOOL_STEPS='2',
                     MOCK_STREAM_TOKENS='240', MOCK_THINKING='1', MOCK_PACE_MS='25'),
        )
        master, slave = pty.openpty()
        screen = pyte.Screen(columns, rows)
        stream = pyte.Stream(screen)
        decoder = codecs.getincrementaldecoder('utf-8')('replace')
        failures = []
        samples = 0
        proc = None

        def drain(seconds):
            deadline = time.monotonic() + seconds
            while time.monotonic() < deadline:
                ready, _, _ = select.select([master], [], [],
                    min(.05, max(0, deadline - time.monotonic())))
                if ready:
                    try:
                        data = os.read(master, 262144)
                    except OSError:
                        break
                    if not data:
                        break
                    stream.feed(decoder.decode(data))

        def check(label):
            nonlocal samples
            samples += 1
            display = screen.display
            composers = sum('❯' in line for line in display)
            footers = sum('Enter 发送' in line for line in display)
            if composers != 1 or footers != 1:
                failures.append((label, composers, footers, display[:]))

        def send(text):
            os.write(master, text.encode())
            drain(.3)

        try:
            deadline = time.monotonic() + 5
            while True:
                try:
                    with socket.create_connection(('127.0.0.1', port), timeout=.2):
                        break
                except OSError:
                    if time.monotonic() >= deadline:
                        raise RuntimeError('mock model did not start')
                    time.sleep(.05)
            fcntl.ioctl(slave, termios.TIOCSWINSZ, struct.pack('HHHH', rows, columns, 0, 0))
            proc = subprocess.Popen(
                ['node', '--import', str(fixture), str(ROOT / 'dist/cli.js'),
                 str(workspace), '--yes', '--no-mesh'],
                cwd=workspace, stdin=slave, stdout=slave, stderr=slave,
                env=env, start_new_session=True,
            )
            os.close(slave)
            slave = None
            drain(2.5)
            check('startup')
            send('fix demo')
            send('\r')
            for index in range(45):
                drain(.2)
                check(f'stream-{index}')
                if index == 8:
                    send('draft while running')
                if index == 12:
                    (base / 'trigger').touch()
                    drain(.6)
                    if not (base / 'warning-done').exists():
                        raise RuntimeError('history warning was not triggered')
                    check('history-warning')
                if index == 14:
                    send('\x15')
                if index == 20:
                    send('/xyzzy')
                    send('\r')
            send('\x15')
            send('alpha\nbeta')
            check('multiline')
            send('\x15')
            check('clear')
            for width, height in [(80, 24), (104, 49), (60, 18), (120, 40)]:
                fcntl.ioctl(master, termios.TIOCSWINSZ, struct.pack('HHHH', height, width, 0, 0))
                screen.resize(height, width)
                proc.send_signal(signal.SIGWINCH)
                drain(.6)
                check(f'resize-{width}x{height}')
            if proc.poll() is not None:
                raise RuntimeError(f'TUI exited unexpectedly: {proc.returncode}')
            print(f'{columns}x{rows}: {samples} screens, {len(failures)} failures')
            if failures:
                label, composers, footers, display = failures[0]
                print(f'{label}: composers={composers}, statusbars={footers}')
                print('\n'.join(f'{i:02}: {line.rstrip()}' for i, line in enumerate(display)))
            return not failures
        finally:
            for child in [proc, mock]:
                if child is None:
                    continue
                child.terminate()
                try:
                    child.wait(timeout=3)
                except subprocess.TimeoutExpired:
                    child.kill()
                    child.wait()
            if slave is not None:
                os.close(slave)
            os.close(master)


if __name__ == '__main__':
    results = [run(104, 49), run(80, 24)]
    raise SystemExit(0 if all(results) else 1)
