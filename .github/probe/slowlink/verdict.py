#!/usr/bin/env python3
"""Verdicts for the slow-link rows (CI copy of research/slow-link-output): verdict.py RUNS_DIR."""
import json, os, sys

runs = sys.argv[1]
row = {n: json.load(open(os.path.join(runs, n + ".summary.json"))) for n in ("on-48k", "off-48k", "on-unl", "off-unl")}
keys = ("fps", "drain_pct", "key_handle_med", "key_handle_p90", "key_handle_max", "tok_lat_med", "tok_lat_p90", "echo_med", "cpu_s", "keys_seen")
show = lambda r: " ".join(f"{k}={r[k]}" for k in keys)
failed = 0
# 48 KB/s: the JS thread no longer waits in write(2); a key is handled within a frame.
ok = row["on-48k"]["drain_pct"] <= 1 and row["on-48k"]["key_handle_med"] < 5
failed += not ok
print(f"{'PASS' if ok else 'FAIL'} slowlink-48k {show(row['on-48k'])}")
print(f"INFO slowlink-48k-off {show(row['off-48k'])}")
# Unlimited link: the writer keeps the frame rate and key handling of the synchronous drain.
on, off = row["on-unl"], row["off-unl"]
ok = on["fps"] >= 0.9 * off["fps"] and on["key_handle_p90"] < 5
failed += not ok
print(f"{'PASS' if ok else 'FAIL'} slowlink-unlimited {show(on)}")
print(f"INFO slowlink-unlimited-off {show(off)}")
sys.exit(1 if failed else 0)
