#!/usr/bin/env python3
"""Drives the lifecycle example under a pseudo-terminal and checks that every exit path restores the terminal.

Runs each scenario twice: once with the hand-written host loop and once with the framework's App::run (--app).

Usage: python3 scripts/pty-smoke.py target/debug/examples/lifecycle
"""

import fcntl
import os
import select
import shlex
import signal
import struct
import subprocess
import sys
import termios
import time

ENTER_ALT = b"\x1b[?1049h"
LEAVE_ALT = b"\x1b[?1049l"


class Pty:
    def __init__(self, command, columns=80, rows=24, shell=False):
        self.master, self.slave = os.openpty()
        self.resize(columns, rows)
        self.before = termios.tcgetattr(self.slave)
        # Its own open file description keeps stdin blocking while stdout is not, as with `app < /dev/tty`.
        self.stdin = os.open(os.ttyname(self.slave), os.O_RDWR | os.O_NOCTTY)
        env = dict(os.environ, TERM="xterm-256color", COLORTERM="truecolor")
        # The child leads a new session, so its process group is orphaned and the kernel discards its stops. A shell
        # takes the terminal as its controlling terminal, so that its jobs can stop.
        controlling = (lambda: fcntl.ioctl(0, termios.TIOCSCTTY, 0)) if shell else None
        self.process = subprocess.Popen(
            command, stdin=self.stdin, stdout=self.slave, stderr=self.slave, env=env, start_new_session=True,
            preexec_fn=controlling,
        )
        self.output = bytearray()

    def resize(self, columns, rows):
        fcntl.ioctl(self.slave, termios.TIOCSWINSZ, struct.pack("HHHH", rows, columns, 0, 0))

    def read(self, seconds, until=None):
        end = time.time() + seconds
        while time.time() < end:
            if until is not None and until in self.output:
                return True
            ready, _, _ = select.select([self.master], [], [], 0.02)
            if ready:
                try:
                    self.output.extend(os.read(self.master, 65536))
                except OSError:
                    break
        return until is None or until in self.output

    def send(self, data):
        os.write(self.master, data)

    def wait(self, seconds=5):
        end = time.time() + seconds
        while time.time() < end:
            code = self.process.poll()
            if code is not None:
                self.read(0.1)
                return code
            self.read(0.05)
        self.process.kill()
        return "timeout"

    def restored(self):
        nonblocking = [fcntl.fcntl(fd, fcntl.F_GETFL) & os.O_NONBLOCK for fd in (self.slave, self.stdin)]
        return termios.tcgetattr(self.slave) == self.before and not any(nonblocking)

    def close(self):
        if self.process.poll() is None:
            self.process.kill()
            self.process.wait()
        os.close(self.master)
        os.close(self.slave)
        os.close(self.stdin)


def scenario(name, command, action, expected_code, expect_text=None, shell=False):
    pty = Pty(command, shell=shell)
    failures = []
    try:
        if not pty.read(3, until=b"lifecycle frame 1"):
            failures.append("first frame never arrived")
        action(pty)
        code = pty.wait()
        if code != expected_code:
            failures.append(f"exit code {code}, expected {expected_code}")
        if ENTER_ALT not in pty.output or LEAVE_ALT not in pty.output:
            failures.append("alternate screen was not entered and left")
        if LEAVE_ALT in pty.output and pty.output.rindex(LEAVE_ALT) < pty.output.rindex(ENTER_ALT):
            failures.append("the alternate screen was entered again after leaving")
        # A shell's terminal state is its own, and on macOS its exit revokes the terminal, so ioctls on it fail.
        if not shell and not pty.restored():
            failures.append("termios or file status flags were not restored")
        if expect_text is not None:
            before, after = pty.output.rsplit(LEAVE_ALT, 1)
            if expect_text in before or expect_text not in after:
                failures.append(f"{expect_text!r} was written before restoration or not after it")
    finally:
        pty.close()
    mode = "app" if "--app" in " ".join(command) else "host"
    print(f"{'PASS' if not failures else 'FAIL'}: {name} ({mode})" + "".join(f"\n  - {failure}" for failure in failures))
    return not failures


def while_stopped(pty, data, *signals):
    # Queues input and signals while the child is stopped, so that it takes them all at one wakeup.
    os.kill(pty.process.pid, signal.SIGSTOP)
    time.sleep(0.05)
    pty.send(data)
    for number in signals:
        os.kill(pty.process.pid, number)
    time.sleep(0.05)
    os.kill(pty.process.pid, signal.SIGCONT)


def suspend_and_continue(pty):
    # The first read takes Ctrl+Z and a q that must not quit (as in Core). On Linux, the last q, past the 4 KiB a read
    # takes, is dropped when the suspension settles; macOS's pseudo-terminal holds only 1 KiB for a stopped reader.
    # Resuming must paint without another wakeup.
    while_stopped(pty, b"\x1aq" + (b"x" * 5000 + b"q" if sys.platform == "linux" else b""))
    if not pty.read(3, until=b"lifecycle frame 2"):
        raise SystemExit("FAIL: no frame after resuming")
    # A stop request and a key at one wakeup: once the key is read, another read of the blocking stdin waits for more.
    while_stopped(pty, b"x")
    os.kill(pty.process.pid, signal.SIGTSTP)
    if not pty.read(3, until=b"lifecycle frame 3"):
        raise SystemExit("FAIL: no frame after a stop request")
    pty.send(b"q")


def write_to_stderr(pty):
    pty.send(b"w")
    pty.read(0.3)
    pty.send(b"q")


def resize_then_quit(pty):
    # A suspension at the same wakeup drops the rest of the input, not the resize.
    pty.resize(100, 30)
    while_stopped(pty, b"\x1a", signal.SIGWINCH)
    if not pty.read(3, until=b"size 100x30"):
        raise SystemExit("FAIL: resize was not drawn")
    pty.send(b"q")


def job_control(pty):
    # The shell's job is a wrapper: it stops with the app, so the shell's fg names the job and continues it.
    pty.send(b"\x1a")
    if not pty.read(3, until=b"bash -c") or not pty.read(3, until=b"lifecycle frame 2"):
        raise SystemExit("FAIL: the job did not stop, or no frame after fg")
    # Not before: an app that runs on while its job is stopped draws over the shell.
    if pty.output.rindex(ENTER_ALT) < pty.output.index(b"bash -c"):
        raise SystemExit("FAIL: the app was set up again before its job continued")
    pty.send(b"q")


def in_shell(command):
    """An interactive shell that runs the command through a wrapper, then fg once it stops."""
    wrapper = shlex.join(["bash", "-c", f"{shlex.join(command)}; :"])
    return ["bash", "--norc", "--noprofile", "-ic", f"{wrapper}; fg"]


def theme_detection(binary):
    """Answers the startup color query with a light background, then reports a switch to dark."""
    pty = Pty([binary, "--app"])
    failures = []
    try:
        if not pty.read(3, until=b"\x1b[c"):
            failures.append("no color query before setup")
        if b"\x1b]4;15;?" not in pty.output:
            failures.append("no palette query before setup")
        pty.send(b"\x1b]4;1;rgb:cd/00/00\x07\x1b]4;2;#00cd00\x07")
        pty.send(b"\x1b]10;rgb:0000/0000/0000\x07\x1b]11;rgb:ffff/ffff/ffff\x07\x1b[?62;22c")
        if not pty.read(3, until=b"theme light"):
            failures.append("the light background was not detected")
        if b"palette 2" not in pty.output:
            failures.append("the two reported palette colors were not kept")
        pty.output.clear()
        pty.send(b"\x1b[?997;1n")
        if not pty.read(3, until=b"\x1b]11;?"):
            failures.append("a color scheme notice did not query the colors again")
        # Only changed cells are redrawn, so look for the new word alone.
        pty.output.clear()
        pty.send(b"\x1b]10;rgb:ffff/ffff/ffff\x07\x1b]11;rgb:1e1e/1e1e/1e1e\x07")
        if not pty.read(3, until=b"dark"):
            failures.append("the switch to a dark background was not reported")
        pty.send(b"q")
        if pty.wait() != 0:
            failures.append("did not exit cleanly")
        if not pty.restored():
            failures.append("termios or file status flags were not restored")
    finally:
        pty.close()
    print(f"{'PASS' if not failures else 'FAIL'}: theme detection (app)" + "".join(f"\n  - {f}" for f in failures))
    return not failures


def main():
    binary = sys.argv[1] if len(sys.argv) > 1 else "target/debug/examples/lifecycle"
    results = []
    for command in ([binary], [binary, "--app"]):
        results += [
            scenario("quit with q", command, lambda pty: pty.send(b"q"), 0),
            scenario("Ctrl+Z and a resize, then quit", command, resize_then_quit, 0),
            scenario("Ctrl+Z and SIGTERM", command, lambda pty: while_stopped(pty, b"\x1a", signal.SIGTERM), 0),
            scenario("SIGTERM", command, lambda pty: os.kill(pty.process.pid, signal.SIGTERM), 0),
            scenario("SIGHUP", command, lambda pty: os.kill(pty.process.pid, signal.SIGHUP), 0),
            scenario("SIGINT", command, lambda pty: os.kill(pty.process.pid, signal.SIGINT), 0),
            scenario("Ctrl+Z and SIGTSTP, then continue", command, suspend_and_continue, 0),
            scenario("Ctrl+Z through a wrapper in a shell, then fg", in_shell(command), job_control, 0, shell=True),
            scenario("returned error", command, lambda pty: pty.send(b"e"), 1, b"lifecycle fixture error"),
            scenario("panic", command, lambda pty: pty.send(b"p"), 101, b"lifecycle fixture panic"),
        ]
    results.append(theme_detection(binary))
    results.append(scenario("stderr capture", [binary, "--app"], write_to_stderr, 0, b"lifecycle stderr line"))
    sys.exit(0 if all(results) else 1)


if __name__ == "__main__":
    main()
