import pty, os, time, select, subprocess, fcntl, termios, struct

master, slave = pty.openpty()
fcntl.ioctl(slave, termios.TIOCSWINSZ, struct.pack('HHHH', 30, 120, 0, 0))
proc = subprocess.Popen(['node', 'dist/cli.js'], stdin=slave, stdout=slave, stderr=slave, close_fds=True)
os.close(slave)
out = b''

def drain(timeout=2.0):
    global out
    end = time.time() + timeout
    while time.time() < end:
        r, _, _ = select.select([master], [], [], 0.2)
        if r:
            try:
                data = os.read(master, 65536)
            except OSError:
                break
            if not data:
                break
            out += data

drain(4)
os.write(master, b'hello')
drain(1)
os.write(master, b'\x19')  # Ctrl+Y -> mouse off
drain(1.5)
os.write(master, b'\x19')  # Ctrl+Y -> mouse on
drain(1.5)
os.write(master, b'/exit\r')
drain(2)
try:
    proc.terminate()
except Exception:
    pass
text = out.decode('utf-8', 'replace')
# Strip ANSI escapes for readability
import re
clean = re.sub(r'\x1b\[[0-9;?]*[a-zA-Z]', '', text)
clean = re.sub(r'\x1b\][^\x07]*\x07', '', clean)
lines = [l for l in clean.splitlines() if l.strip()]
print('\n'.join(lines[-25:]))
