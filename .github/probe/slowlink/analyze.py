#!/usr/bin/env python3
"""Analyze harness runs: analyze.py NAME... -> one row each (and runs/NAME.summary.json)."""
import json, os, re, statistics, sys

import pyte

HERE = os.path.dirname(os.path.abspath(__file__))
COLS, ROWS = 100, 32
SET, RESET = b"\x1b[?2026h", b"\x1b[?2026l"


class Screen(pyte.Screen):
    def report_device_status(self, *a, **k):
        pass

    def report_device_attributes(self, *a, **k):
        pass

    def write_process_input(self, data):
        pass


def pct(xs, p):
    if not xs:
        return float("nan")
    xs = sorted(xs)
    return xs[min(len(xs) - 1, int(round(p / 100 * (len(xs) - 1))))]


def analyze(name):
    base = os.path.join(HERE, "runs", name)
    raw = open(base + ".raw", "rb").read()
    idx = json.load(open(base + ".idx.json"))
    app = json.load(open(base + ".app.json"))
    arrivals = idx["arrivals"]
    sent = idx["sent"]
    a = idx["args"]
    # measurement window: from first token due to the last key sent
    t0 = app["start"] / 1000.0
    t1 = sent[-1][1]
    secs = t1 - t0

    # link bytes in the window
    off, offs = 0, []
    for t, n in arrivals:
        offs.append((off, off + n, t))
        off += n
    win_bytes = sum(n for t, n in arrivals if t0 <= t <= t1 + a["delay"] / 1000.0)

    # frames by envelope (direct runs with the envelope only)
    starts = [m.start() for m in re.finditer(re.escape(SET), raw)]
    frame_sizes = [b - s for s, b in zip(starts, starts[1:])]

    # app side
    frames = [f / 1000.0 for f in app["frames"] if t0 <= f / 1000.0 <= t1]
    fps = len(frames) / secs
    drains = [d for d in app["drains"] if t0 <= d["t"] / 1000.0 <= t1]
    drain_ms = sum(d["ms"] for d in drains)
    drain_max = max((d["ms"] for d in drains), default=0)
    lags = app["lags"]
    blocked = sum(l - 2 for l in lags if l > 10)
    lag_max = max(lags)
    handled = {k["n"]: k["handled"] / 1000.0 for k in app["keys"]}
    key_lat = [(handled[n] - t) * 1000 for n, t in sent if n in handled]

    # terminal emulation: visible status values over time
    screen = Screen(COLS, ROWS)
    stream = pyte.ByteStream(screen)
    depth = 0
    vis_tok, vis_key = [], []  # (time, value)
    last = (None, None)
    # split points: chunk ends and sync markers
    marks = sorted([m.end() for m in re.finditer(re.escape(SET), raw)] + [m.end() for m in re.finditer(re.escape(RESET), raw)])
    mi = 0
    for s, e, t in offs:
        pos = s
        while pos < e:
            while mi < len(marks) and marks[mi] <= pos:
                mi += 1
            cut = min(e, marks[mi]) if mi < len(marks) else e
            seg = raw[pos:cut]
            stream.feed(seg)
            if seg.endswith(SET):
                depth = 1
            elif seg.endswith(RESET):
                depth = 0
            pos = cut
            if depth == 0:
                row = screen.display[ROWS - 1]
                m = re.search(r"tok (\d{6}) key (\d{6})", row)
                if m:
                    v = (int(m.group(1)), int(m.group(2)))
                    if v != last:
                        if v[0] != last[0]:
                            vis_tok.append((t, v[0]))
                        if v[1] != last[1]:
                            vis_key.append((t, v[1]))
                        last = v

    def first_visible(vis, n):
        for t, v in vis:
            if v >= n:
                return t
        return None

    tok_lat = []
    for tk in app["tokens"]:
        due = tk["due"] / 1000.0
        if not (t0 <= due <= t1):
            continue
        tv = first_visible(vis_tok, tk["n"])
        if tv is not None:
            tok_lat.append((tv - due) * 1000)
    echo_lat = []
    for n, t in sent:
        tv = first_visible(vis_key, n)
        if tv is not None:
            echo_lat.append((tv - t) * 1000)
    vis_updates = len([1 for t, v in vis_tok if t0 <= t <= t1])

    r = {
        "name": name,
        "tmux": a["tmux"],
        "rate": a["rate"],
        "secs": round(secs, 1),
        "fps": round(fps, 1),
        "visible_tok_updates_s": round(vis_updates / secs, 1),
        "bytes_s": round(win_bytes / secs),
        "frame_bytes_med": pct(frame_sizes, 50),
        "frame_bytes_p90": pct(frame_sizes, 90),
        "bytes_per_frame_mean": round(win_bytes / max(1, len(frames))),
        "drain_ms_total": round(drain_ms),
        "drain_ms_max": round(drain_max, 1),
        "drain_pct": round(100 * drain_ms / (secs * 1000), 1),
        "loop_blocked_ms": round(blocked),
        "loop_lag_max": round(lag_max, 1),
        "key_handle_med": round(pct(key_lat, 50), 1),
        "key_handle_p90": round(pct(key_lat, 90), 1),
        "key_handle_max": round(max(key_lat, default=float("nan")), 1),
        "echo_med": round(pct(echo_lat, 50), 1),
        "echo_p90": round(pct(echo_lat, 90), 1),
        "tok_lat_med": round(pct(tok_lat, 50), 1),
        "tok_lat_p90": round(pct(tok_lat, 90), 1),
        "keys_seen": f"{len(echo_lat)}/{len(sent)}",
        "nonblock": idx["nonblock"],
        "load": round(idx["load"][0], 1),
        "cpu_s": round((app["cpu"]["user"] + app["cpu"]["system"]) / 1e6, 2) if "cpu" in app else None,
    }
    json.dump(r, open(base + ".summary.json", "w"))
    return r


if __name__ == "__main__":
    rows = [analyze(n) for n in sys.argv[1:]]
    keys = list(rows[0].keys())
    print("\t".join(keys))
    for r in rows:
        print("\t".join(str(r[k]) for k in keys))
