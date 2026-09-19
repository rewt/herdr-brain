#!/usr/bin/env python3
"""Offline PTY smoke: real Ink, input packets, resize, and terminal cleanup."""
import fcntl
import os
from pathlib import Path
import pty
import select
import signal
import struct
import subprocess
import termios
import time

root = Path(__file__).resolve().parents[2]
master, slave = pty.openpty()
fcntl.ioctl(slave, termios.TIOCSWINSZ, struct.pack('HHHH', 41, 100, 0, 0))
env = dict(os.environ, NO_COLOR='1')
proc = subprocess.Popen(['node', str(root / 'console/proto/main.mjs')], stdin=slave, stdout=slave, stderr=slave, cwd=root, env=env)
os.close(slave)
transcript = b''

def read_until(expected, timeout=4):
    global transcript
    data = b''
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        if select.select([master], [], [], 0.05)[0]:
            try:
                chunk = os.read(master, 100000)
            except OSError:
                break
            if not chunk:
                break
            data += chunk
            transcript += chunk
            if expected.encode() in data:
                return data
    raise AssertionError(f'Missing {expected!r}: {data[-2500:]!r}')

def send(data, expected):
    os.write(master, data)
    return read_until(expected)

try:
    read_until('Open items 12')
    send(b'e', 'Next work / recorded executive decisions')
    send(b'\r', 'Authority then: G-1/note-42')
    send(b'a', 'Goal authority / operator direction')
    send(b'2', 'Pause future pickup for this goal')
    send(b'b', 'Goal authority / operator direction')
    send(b'r', 'Allowed work')
    send(b'\x1b[200~ b!12[e\x1b[201~\t\t\r', 'Goal authority / operator direction')
    send(b'bbn', 'Run executive now')
    send(b'\r', 'No model ran')
    send(b'n', 'no duplicate request')
    send(b'b', 'Open items 12')
    send(b'\x1b[<0;3;6M\x1b[<0;3;6m\x1b[B', 'harbor > G-1 > All tasks')
    send(b']', 'Reliable imports is #2')
    send(b'[', 'Reliable imports is #1')
    send(b'\t\x1b[B\t\r', 'Your draft / never sent')
    os.write(master, b'\x1b[<0;5;')
    time.sleep(0.01)
    send(b'10M\x1b[<0;5;10m', 'Review the action')
    send(b'br', 'Tab: field')
    send(b' -- checked\t\t\r', 'rows. -- checked')
    send(b'b!', 'Needs you / all projects')
    send(b'bs\r', 'Serves: ENG-1')
    send(b'\r', 'Peek / fixture capture')
    send(b'bb:lanes\r', 'Lanes and worktrees')
    send(b'\r', 'Branch: lane/imports')
    send(b'b', 'Lanes: topic')
    fcntl.ioctl(master, termios.TIOCSWINSZ, struct.pack('HHHH', 31, 80, 0, 0))
    proc.send_signal(signal.SIGWINCH)
    send(b'!', 'Needs you / all projects')
    send(b'\x1b[<65;35;10M', 'Keep the existing file format')
    send(b'bq', '\x1b[?1049l')
    proc.wait(timeout=4)
    assert proc.returncode == 0
    for mode in [b'\x1b[?1006l', b'\x1b[?1000l', b'\x1b[?2004l', b'\x1b[?25h']:
        assert mode in transcript, f'Missing cleanup {mode!r}'
    print('PASS: Ink ranking, authority review/cancel, paste ownership, executive request/deduplication, keyboard, click, fragmented SGR, reply cancel, stack, lanes, resize, wheel, quit and cleanup.')
finally:
    if proc.poll() is None:
        proc.terminate()
        proc.wait(timeout=4)
    os.close(master)
