#!/usr/bin/env python3
"""Pty checks for the stdout writer on macOS (388, PR 4). The pty loop is
research/frame-output-backpressure/probe/ptyrun.py's: the parent is the terminal, stops reading the
master to stall the link, and drains it again later.

usage: writer-checks.py OUTDIR [CHECK...]   prints one PASS or FAIL line per check.
Each check runs writer-fixture.ts once; `-off` rows set OTUI_STDOUT_THREAD=0 as the control. INFO rows
are reported without a verdict."""
import fcntl, json, os, pty, select, signal, struct, sys, termios, time

HERE = os.path.dirname(os.path.abspath(__file__))
FIXTURE = os.path.join(HERE, "writer-fixture.ts")
COLS, ROWS = 100, 32
MOUSE = b"\x1b[<0;10;5M\x1b[<0;10;5m"
outdir = sys.argv[1]
os.makedirs(outdir, exist_ok=True)


class Run:
    def __init__(self, name, mode, off=False, nonblock=False, stall_max=4.0):
        self.name, self.mode, self.off, self.nonblock, self.stall_max = name, mode, off, nonblock, stall_max
        self.status = os.path.join(outdir, name + ".status")
        self.err = os.path.join(outdir, name + ".err")
        self.out = bytearray()
        self.events = {}
        self.ready_at = None
        self.resume_at = None
        self.code = None
        self.stops = 0
        self.hung = False
        self.timers = []

    def start(self):
        for path in (self.status, self.status + ".continue"):
            if os.path.exists(path):
                os.remove(path)
        env = dict(os.environ, TERM="xterm-256color", COLORTERM="truecolor")
        if self.nonblock:
            env["WRITER_NONBLOCK"] = "1"
        if self.off:
            env["OTUI_STDOUT_THREAD"] = "0"
        else:
            env.pop("OTUI_STDOUT_THREAD", None)
        self.pid, self.fd = pty.fork()
        if self.pid == 0:
            e = os.open(self.err, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o644)
            os.dup2(e, 2)
            fcntl.ioctl(0, termios.TIOCSWINSZ, struct.pack("HHHH", ROWS, COLS, 0, 0))
            os.execvpe("bun", ["bun", FIXTURE, self.mode, self.status], env)

    def new_events(self, offset):
        if not os.path.exists(self.status):
            return offset, []
        with open(self.status) as f:
            f.seek(offset)
            text = f.read()
        lines = text.split("\n")
        done = text[: len(text) - len(lines[-1])]
        return offset + len(done), [json.loads(line) for line in lines[:-1] if line]

    def stalled(self, now):
        if self.ready_at is None:
            return False
        if self.resume_at is not None and now >= self.resume_at:
            return False
        return now < self.ready_at + self.stall_max

    def drain(self, timeout):
        while True:
            r, _, _ = select.select([self.fd], [], [], timeout)
            if not r:
                return
            try:
                data = os.read(self.fd, 65536)
            except OSError:
                return
            if not data:
                return
            self.out += data

    def go(self, handlers):
        self.start()
        offset, t_start = 0, time.time()
        while True:
            now = time.time()
            offset, events = self.new_events(offset)
            for ev in events:
                self.events[ev["event"]] = ev
                if ev["event"] == "ready":
                    self.ready_at = now
                handler = handlers.get(ev["event"])
                if handler:
                    handler(self, now)
            for timer in [t for t in self.timers if t[0] <= now]:
                self.timers.remove(timer)
                timer[1](self, now)
            if self.stalled(now):
                time.sleep(0.005)
            else:
                self.drain(0.01)
            wp, st = os.waitpid(self.pid, os.WNOHANG | os.WUNTRACED)
            if wp and os.WIFSTOPPED(st):
                self.stops += 1
                stopped = handlers.get("stopped")
                if stopped:
                    stopped(self, now)
            elif wp:
                self.code = os.waitstatus_to_exitcode(st)
                self.drain(0.3)
                for ev in self.new_events(offset)[1]:
                    self.events[ev["event"]] = ev
                break
            if now - t_start > 30:
                self.hung = True
                os.kill(self.pid, signal.SIGKILL)
                os.waitpid(self.pid, 0)
                break
        open(os.path.join(outdir, self.name + ".out"), "wb").write(self.out)
        os.close(self.fd)
        return self

    def stderr(self):
        return open(self.err, "rb").read()

    def lag(self, event):
        return self.events.get(event, {}).get("lagMax")


def restored(out):
    """The last alternate-screen entry is left and the cursor is visible again."""
    enter, leave = out.rfind(b"\x1b[?1049h"), out.rfind(b"\x1b[?1049l")
    hide, show = out.rfind(b"\x1b[?25l"), out.rfind(b"\x1b[?25h")
    return enter >= 0 and leave > enter and show > hide


def resume_after(delay):
    def handler(run, now):
        run.resume_at = now + delay

    return handler


def check_exit(name, off, nonblock):
    run = Run(name, "exit", off=off, nonblock=nonblock).go({"exiting": resume_after(0.3)})
    lag = run.lag("exiting")
    fd_nonblock = run.events.get("exiting", {}).get("nonblock")
    ok = not run.hung and run.code == 0 and run.stderr() == b"" and restored(run.out) and fd_nonblock == nonblock
    detail = (
        f"code={run.code} hung={run.hung} stderr={len(run.stderr())} restored={restored(run.out)} "
        f"lag_ms={lag} fd1_nonblock={fd_nonblock}"
    )
    # Blocking fd: with the writer the JS thread keeps running while the link is stalled; without it the
    # synchronous drain blocks it until the parent reads again (the control shows the check can fail).
    if not nonblock:
        ok = ok and lag is not None and (lag >= 1000 if off else lag < 250)
    elif off:
        # The synchronous drain gives up on EAGAIN at exit and leaves the terminal unrestored (D2, fixed
        # only on the writer path): reported, not judged.
        return None, detail
    return ok, detail


def check_suspend(name, off):
    def called(run, now):
        os.write(run.fd, MOUSE)
        run.resume_at = now + 0.3

    def proceed(run, now):
        open(run.status + ".continue", "w").close()

    def suspended(run, now):
        run.resume_at = now
        # The child leads its own session, so its group is orphaned and the kernel drops SIGTSTP; SIGSTOP
        # stops it the same way. If it does not, `stops` stays 0 and the check fails without a hang.
        os.kill(run.pid, signal.SIGSTOP)
        run.timers.append((now + 2.0, proceed))

    def stopped(run, now):
        time.sleep(0.2)
        os.kill(run.pid, signal.SIGCONT)
        run.timers = []
        proceed(run, now)

    run = Run(name, "suspend", off=off).go({"suspend-called": called, "suspended": suspended, "stopped": stopped})
    # The renderer never writes a mouse report, so any copy in the output is the tty's echo (raw or ^[).
    # Reported, not judged: suspend() leaves raw mode before the Session's suspend bytes drain on both
    # paths, so compare with the -off row.
    echoed = run.out.count(b"<0;10;5")
    ok = (
        not run.hung
        and run.code == 0
        and run.stops == 1
        and "resumed" in run.events
        and "closed" in run.events
        and run.stderr() == b""
        and restored(run.out)
    )
    events = ",".join(run.events)
    detail = (
        f"code={run.code} hung={run.hung} stops={run.stops} echoed={echoed} "
        f"stderr={len(run.stderr())} restored={restored(run.out)} events={events}"
    )
    return ok, detail


def check_crash_active(name, off):
    run = Run(name, "crash-active", off=off, stall_max=0).go({})
    ok = not run.hung and run.code == 0 and run.stderr() == b"" and "survived" in run.events and restored(run.out)
    return ok, f"code={run.code} hung={run.hung} stderr={len(run.stderr())} restored={restored(run.out)}"


def check_crash_after_destroy(name, off):
    run = Run(name, "crash-after-destroy", off=off).go({"destroyed": resume_after(1.0)})
    printed = b"boom-after-destroy" in run.stderr()
    ok = not run.hung and run.code is not None and printed and restored(run.out)
    return ok, f"code={run.code} hung={run.hung} stderr_has_error={printed} restored={restored(run.out)}"


CHECKS = {
    "exit-blocking": lambda: check_exit("exit-blocking", False, False),
    "exit-blocking-off": lambda: check_exit("exit-blocking-off", True, False),
    "exit-nonblock": lambda: check_exit("exit-nonblock", False, True),
    "exit-nonblock-off": lambda: check_exit("exit-nonblock-off", True, True),
    "suspend": lambda: check_suspend("suspend", False),
    "suspend-off": lambda: check_suspend("suspend-off", True),
    "crash-active": lambda: check_crash_active("crash-active", False),
    "crash-after-destroy": lambda: check_crash_after_destroy("crash-after-destroy", False),
    "crash-after-destroy-off": lambda: check_crash_after_destroy("crash-after-destroy-off", True),
}

failed = 0
for name in sys.argv[2:] or list(CHECKS):
    ok, detail = CHECKS[name]()
    failed += ok is False
    print(f"{'INFO' if ok is None else 'PASS' if ok else 'FAIL'} {name} {detail}", flush=True)
sys.exit(1 if failed else 0)
