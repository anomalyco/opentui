#!/usr/bin/env python3
"""Slow-link harness: run app.ts in a pty (optionally behind a private tmux server)
and drain the pty master through a modelled link (rate R, one-way delay D, send buffer B).

usage: harness.py NAME --tree DIR --lib SO [--tmux] [--rate BPS] [--delay MS] [--sndbuf BYTES] [--secs S]
Writes runs/NAME.{raw,idx,json} and prints a summary line.
"""
import argparse, fcntl, json, os, pty, select, signal, struct, subprocess, sys, termios, threading, time

HERE = os.path.dirname(os.path.abspath(__file__))
COLS, ROWS = 100, 32

ap = argparse.ArgumentParser()
ap.add_argument("name")
ap.add_argument("--tree", required=True)
ap.add_argument("--lib", required=True)
ap.add_argument("--tmux", action="store_true")
ap.add_argument("--rate", type=float, default=0, help="link bytes/s, 0 = unlimited")
ap.add_argument("--delay", type=float, default=20, help="one-way delay ms")
ap.add_argument("--sndbuf", type=int, default=65536)
ap.add_argument("--secs", type=float, default=20)
ap.add_argument("--line-tokens", type=int, default=6)
ap.add_argument("--nonblock", action="store_true")
ap.add_argument("--gov", type=int, default=0)
ap.add_argument("--pace", type=int, default=0)
ap.add_argument("--key-ms", type=float, default=250)
args = ap.parse_args()

runs = os.path.join(HERE, "runs")
os.makedirs(runs, exist_ok=True)
base = os.path.join(runs, args.name)
applog = base + ".app.json"
core = os.path.join(args.tree, "packages/core")
env = dict(os.environ, TERM="xterm-256color", COLORTERM="truecolor", SL_LIB=args.lib, SL_LOG=applog, SL_LINE_TOKENS=str(args.line_tokens), SL_NONBLOCK="1" if args.nonblock else "0", SL_GOV=str(args.gov), SL_PACE=str(args.pace))
for k in ("TMUX", "TMUX_PANE", "SSH_CONNECTION", "SSH_TTY", "SSH_CLIENT"):
    env.pop(k, None)
if os.path.exists(applog):
    os.remove(applog)

def app_pid():
    for p in os.listdir("/proc"):
        if not p.isdigit():
            continue
        try:
            cmd = open(f"/proc/{p}/cmdline", "rb").read().split(b"\0")
            if cmd[:2] == [b"bun", b"slowlink-app.ts"] and os.readlink(f"/proc/{p}/cwd") == core:
                return p
        except OSError:
            pass
    return None


sock = os.path.join(HERE, "tmux.sock")
appcmd = ["bun", os.path.join(HERE, "app-entry.ts")]
# app.ts imports ./src relative to packages/core; copy it there.
entry = os.path.join(core, "slowlink-app.ts")
with open(os.path.join(HERE, "app.ts")) as f:
    src = f.read()
with open(entry, "w") as f:
    f.write(src)

if args.tmux:
    subprocess.run(["tmux", "-S", sock, "kill-server"], stderr=subprocess.DEVNULL)
    inner = " ".join(f"{k}={v}" for k, v in [("SL_LIB", args.lib), ("SL_LOG", applog), ("COLORTERM", "truecolor"), ("SL_LINE_TOKENS", str(args.line_tokens)), ("SL_NONBLOCK", "1" if args.nonblock else "0")])
    subprocess.run(["tmux", "-S", sock, "-f", "/dev/null", "new-session", "-d", "-x", str(COLS), "-y", str(ROWS),
                    f"cd {core} && env {inner} bun slowlink-app.ts; sleep 1"], env=env, check=True)
    subprocess.run(["tmux", "-S", sock, "set", "-g", "status", "off"], check=True)
    child_argv = ["tmux", "-S", sock, "attach"]
else:
    child_argv = ["bun", "slowlink-app.ts"]

pid, fd = pty.fork()
if pid == 0:
    os.chdir(core)
    if args.nonblock:
        fcntl.fcntl(1, fcntl.F_SETFL, fcntl.fcntl(1, fcntl.F_GETFL) | os.O_NONBLOCK)
    os.execvpe(child_argv[0], child_argv, env)
fcntl.ioctl(fd, termios.TIOCSWINSZ, struct.pack("HHHH", ROWS, COLS, 0, 0))

sendq = bytearray()
lock = threading.Lock()
arrivals = []  # (arrival_time, bytes)
stop = False
D = args.delay / 1000.0


def reader():
    global stop
    while not stop:
        with lock:
            room = args.sndbuf - len(sendq)
        if room <= 0:
            time.sleep(0.0005)
            continue
        r, _, _ = select.select([fd], [], [], 0.05)
        if not r:
            continue
        try:
            data = os.read(fd, min(room, 65536))
        except OSError:
            break
        if not data:
            break
        with lock:
            sendq.extend(data)


def link():
    last = time.time()
    credit = 0.0
    while not stop or sendq:
        time.sleep(0.001)
        t = time.time()
        dt, last = t - last, t
        with lock:
            if not sendq:
                credit = 0.0
                continue
            if args.rate <= 0:
                n = len(sendq)
            else:
                credit = min(credit + args.rate * dt, args.rate * 0.005 + 1)
                n = min(len(sendq), int(credit))
                credit -= n
            if n:
                arrivals.append((t + D, bytes(sendq[:n])))
                del sendq[:n]
        if stop and t > stop_time + 5:
            break


stop_time = 1e18
th_r = threading.Thread(target=reader, daemon=True)
th_l = threading.Thread(target=link, daemon=True)
th_r.start()
th_l.start()

time.sleep(3.0)
nonblock = None
try:
    out = [app_pid()]
    if out[0]:
        with open(f"/proc/{out[0]}/fdinfo/1") as f:
            flags = int([l for l in f if l.startswith("flags")][0].split()[1], 8)
        nonblock = bool(flags & os.O_NONBLOCK)
except Exception as e:
    nonblock = repr(e)

sent = []
t_end = time.time() + args.secs
n = 0
while time.time() < t_end:
    time.sleep(args.key_ms / 1000.0)
    n += 1
    sent.append((n, time.time()))
    os.write(fd, b"x")
cpu = None
try:
    out = [app_pid()]
    with open(f"/proc/{out[0]}/stat") as f:
        st = f.read().rsplit(")", 1)[1].split()
    cpu = (int(st[11]) + int(st[12])) / os.sysconf("SC_CLK_TCK")
except Exception as e:
    cpu = repr(e)
os.write(fd, b"q")
# wait for the app log
for _ in range(400):
    if os.path.exists(applog) and os.path.getsize(applog) > 0:
        break
    time.sleep(0.05)
time.sleep(0.5)
stop_time = time.time()
# let the link drain what is queued (bounded)
for _ in range(600):
    with lock:
        if not sendq:
            break
    time.sleep(0.05)
stop = True
if args.tmux:
    subprocess.run(["tmux", "-S", sock, "kill-server"], stderr=subprocess.DEVNULL)
try:
    os.kill(pid, signal.SIGTERM)
except ProcessLookupError:
    pass
try:
    os.waitpid(pid, 0)
except ChildProcessError:
    pass
os.remove(entry)

with open(base + ".raw", "wb") as f:
    for _, b in arrivals:
        f.write(b)
with open(base + ".idx.json", "w") as f:
    json.dump({"arrivals": [(t, len(b)) for t, b in arrivals], "sent": sent, "nonblock": nonblock, "cpu": cpu,
               "args": vars(args), "load": os.getloadavg()}, f)
print(f"{args.name}: {sum(len(b) for _, b in arrivals)} bytes, {len(sent)} keys, stdout nonblock={nonblock}, cpu={cpu}s, "
      f"load={os.getloadavg()[0]:.1f}")
