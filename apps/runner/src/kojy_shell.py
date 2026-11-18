"""
KojyAI shell — a real terminal (PTY) for the owner, in the bot's own folder.
OWNERSHIP: apps/runner (started by terminal.ts, as the project's sandbox user)

    python3 kojy_shell.py <cols> <rows> <rcfile>

fd 0      keystrokes from the browser, written to the terminal as-is
fd 1      everything the terminal prints, as-is
fd 3      control lines from the runner: {"cols": 120, "rows": 30}

When fd 0 closes (the owner closed the shell, or the runner is stopping) the
shell's whole process group gets SIGHUP, then SIGKILL a moment later. The exit
status is the shell's.
"""

import errno
import fcntl
import json
import os
import pty
import select
import signal
import struct
import sys
import termios
import time

CONTROL_FD = 3


def set_size(fd, cols, rows):
    cols = max(10, min(int(cols), 500))
    rows = max(3, min(int(rows), 200))
    fcntl.ioctl(fd, termios.TIOCSWINSZ, struct.pack("HHHH", rows, cols, 0, 0))


def hang_up(pid):
    for sig in (signal.SIGHUP, signal.SIGKILL):
        try:
            os.killpg(pid, sig)
        except ProcessLookupError:
            return
        except PermissionError:
            return
        deadline = time.time() + 1.5
        while time.time() < deadline:
            try:
                done, _ = os.waitpid(pid, os.WNOHANG)
            except ChildProcessError:
                return
            if done:
                return
            time.sleep(0.05)


def write_all(fd, data):
    while data:
        try:
            n = os.write(fd, data)
        except OSError as e:
            if e.errno == errno.EINTR:
                continue
            raise
        data = data[n:]


def main():
    cols, rows, rcfile = int(sys.argv[1]), int(sys.argv[2]), sys.argv[3]
    pid, master = pty.fork()
    if pid == 0:
        # The child: a fresh session leader with the PTY as its terminal.
        shell = "/bin/bash"
        args = [shell, "--noprofile", "--rcfile", rcfile, "-i"] if os.path.exists(rcfile) else [shell, "-i"]
        os.execve(shell, args, os.environ)

    set_size(master, cols, rows)
    control_open = True
    try:
        os.fstat(CONTROL_FD)
    except OSError:
        control_open = False
    partial = b""
    status = 0

    while True:
        watch = [0, master] + ([CONTROL_FD] if control_open else [])
        try:
            ready, _, _ = select.select(watch, [], [], 1.0)
        except InterruptedError:
            continue

        if master in ready:
            try:
                data = os.read(master, 65536)
            except OSError as e:
                if e.errno == errno.EIO:  # the shell exited and the PTY closed
                    data = b""
                else:
                    raise
            if not data:
                break
            write_all(1, data)

        if 0 in ready:
            data = os.read(0, 65536)
            if not data:  # the owner closed the shell
                hang_up(pid)
                break
            write_all(master, data)

        if control_open and CONTROL_FD in ready:
            chunk = os.read(CONTROL_FD, 4096)
            if not chunk:
                control_open = False
            else:
                lines = (partial + chunk).split(b"\n")
                partial = lines.pop()
                for line in lines:
                    try:
                        msg = json.loads(line)
                        # The kernel tells the foreground program (SIGWINCH).
                        set_size(master, msg.get("cols", cols), msg.get("rows", rows))
                    except Exception:
                        pass

    try:
        _, raw = os.waitpid(pid, 0)
        status = os.waitstatus_to_exitcode(raw)
    except ChildProcessError:
        pass
    sys.exit(status if status >= 0 else 128 - status)


if __name__ == "__main__":
    main()
