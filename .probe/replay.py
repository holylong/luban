import codecs, fcntl, json, os, pty, select, signal, socket, struct, subprocess, sys, tempfile, termios, time
from pathlib import Path
sys.path.insert(0, str(Path(__file__).parent / 'terminal-deps'))
import pyte
ROOT = Path.cwd()

def run(cols, rows):
    with tempfile.TemporaryDirectory(dir=ROOT / '.probe', prefix='replay-') as home:
        workspace = Path(home) / 'workspace'
        workspace.mkdir()
        with socket.socket() as sock:
            sock.bind(('127.0.0.1', 0))
            port = sock.getsockname()[1]
        config = {'model': {'active': 'mock/mock-model', 'timeout': 30}, 'providers': {'mock': {'options': {'baseURL': f'http://127.0.0.1:{port}/v1', 'apiKey': 'local'}, 'models': {'mock-model': {'name': 'Mock Model'}}}}, 'max_steps': 8}
        (Path(home) / 'config.json').write_text(json.dumps(config))
        env = dict(os.environ, LUBAN_HOME=home, TERM='xterm-256color', FORCE_COLOR='3', COLORTERM='truecolor')
        env.pop('CI', None)
        mock = subprocess.Popen(['node', 'scripts/mock-model.mjs', str(port)], cwd=ROOT, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, env=dict(env, MOCK_DELAY_MS='300', MOCK_TOOL_STEPS='2', MOCK_STREAM_TOKENS='240', MOCK_THINKING='1', MOCK_PACE_MS='25'))
        master, slave = pty.openpty()
        fcntl.ioctl(slave, termios.TIOCSWINSZ, struct.pack('HHHH', rows, cols, 0, 0))
        screen = pyte.Screen(cols, rows)
        stream = pyte.Stream(screen)
        decoder = codecs.getincrementaldecoder('utf-8')('replace')
        raw = bytearray()
        problems = []
        samples = 0
        proc = subprocess.Popen(['node', '--import', 'tsx', '--import', str(ROOT / '.probe/history-warning.mjs'), str(ROOT / 'src/cli.tsx'), str(workspace), '--yes', '--no-mesh'], cwd=ROOT, stdin=slave, stdout=slave, stderr=slave, env=env, start_new_session=True)
        terminal_name = os.ttyname(slave)
        os.close(slave)
        def drain(seconds):
            end = time.monotonic() + seconds
            while time.monotonic() < end:
                ready, _, _ = select.select([master], [], [], min(.05, max(0, end-time.monotonic())))
                if ready:
                    try: data = os.read(master, 262144)
                    except OSError: break
                    if not data: break
                    raw.extend(data)
                    stream.feed(decoder.decode(data))
        def check(label):
            nonlocal samples
            samples += 1
            display = screen.display
            inputs = [(i, line) for i, line in enumerate(display) if 'Message luban' in line or '补充指令 · /queue' in line]
            footers = [(i, line) for i, line in enumerate(display) if 'Enter 发送' in line]
            if len(inputs) > 1 or len(footers) != 1:
                problems.append((label, len(inputs), len(footers), display))
        def send(text, seconds=.3):
            os.write(master, text.encode())
            drain(seconds)
        try:
            drain(2.5)
            check('startup')
            send('fix demo')
            send('\r')
            for i in range(45):
                drain(.2)
                check(f'stream-{i}')
                if i == 8: send('draft while running')
                if i == 14: send('\x15')
                if i == 20: send('/xyzzy'); send('\r')
            send('\x15'); send('alpha\nbeta'); check('multiline')
            send('\x15'); check('clear')
            for new_cols, new_rows in [(80, 24), (104, 49), (60, 18), (120, 40)]:
                fcntl.ioctl(master, termios.TIOCSWINSZ, struct.pack('HHHH', new_rows, new_cols, 0, 0))
                screen.resize(new_rows, new_cols)
                proc.send_signal(signal.SIGWINCH)
                drain(.6)
                check(f'resize-{new_cols}x{new_rows}')
            print(f'{cols}x{rows}: {samples} screens, {len(problems)} failures', flush=True)
            (ROOT / '.probe' / f'replay-{cols}x{rows}.ansi').write_bytes(raw)
            if problems:
                label, inputs, footers, display = problems[0]
                print(f'FIRST FAILURE {label}: composers={inputs}, statusbars={footers}')
                for i, line in enumerate(display): print(f'{i:02}: {line.rstrip()}')
            return not problems
        finally:
            proc.terminate(); mock.terminate()
            for child in [proc, mock]:
                try: child.wait(timeout=3)
                except subprocess.TimeoutExpired: child.kill(); child.wait()
            os.close(master)

results = [run(104, 49), run(80, 24)]
sys.exit(0 if all(results) else 1)
