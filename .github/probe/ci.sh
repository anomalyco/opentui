#!/usr/bin/env bash
# Every check of the macOS stdout writer workflow (388, PR 4). Prints one PASS, FAIL or INFO line per
# check to probe-out/summary.txt and keeps going after a failure. Run from the repository root after
# `bun install` and `bun run build:native` in packages/core.
set -uo pipefail
repo=$(cd "$(dirname "$0")/../.." && pwd)
out=$repo/probe-out
mkdir -p "$out"
summary=$out/summary.txt
: >"$summary"
# macOS has no timeout(1).
limit() {
  local secs=$1
  shift
  perl -e 'alarm shift; exec @ARGV' "$secs" "$@"
}
line() { echo "$*" | tee -a "$summary"; }

{ uname -a; sw_vers; bun --version; zig version; } >"$out/host.txt" 2>&1
cat "$out/host.txt"
cd "$repo/packages/core"

# The writer's Zig tests, on real threads; none may be skipped.
limit 1800 bun run test:native -Dtest-filter=writer >"$out/native-writer.txt" 2>&1
rc=$?
summary_line=$(grep -m1 "Build Summary" "$out/native-writer.txt")
if [ $rc = 0 ] && ! grep -q skipped <<<"$summary_line"; then line "PASS native-writer-tests $summary_line"; else line "FAIL native-writer-tests rc=$rc $summary_line"; fi

# The same tests in one file under TSan.
(cd ../native && limit 1200 zig test -fllvm -fsanitize-thread -lc src/stdout-writer.zig) >"$out/tsan.txt" 2>&1
rc=$?
if [ $rc = 0 ] && grep -q "All 8 tests passed" "$out/tsan.txt"; then
  line "PASS tsan $(grep 'tests passed' "$out/tsan.txt" | tail -1)"
elif grep -q "libtsan" "$out/tsan.txt" && ! grep -q "tests passed\|failed\." "$out/tsan.txt"; then
  line "INFO tsan unsupported: $(grep -m1 error "$out/tsan.txt")"
else
  line "FAIL tsan rc=$rc $(grep -m1 'FAIL\|error\|WARNING: ThreadSanitizer' "$out/tsan.txt")"
fi

# A writer blocked in write(2) outlives Session cancel and library dispose (the dylib pin).
limit 300 bun test src/tests/stdout-writer-unload.test.ts >"$out/unload.txt" 2>&1
rc=$?
if [ $rc = 0 ] && grep -q "^ *1 pass" "$out/unload.txt"; then line "PASS unload-test"; else line "FAIL unload-test rc=$rc"; fi

# Pty checks: exit restore, suspend and resume, crashes.
cd "$repo"
limit 900 python3 .github/probe/writer-checks.py "$out/pty" 2>&1 | tee "$out/pty.txt"
grep -E '^(PASS|FAIL|INFO) ' "$out/pty.txt" >>"$summary"
grep -qE '^(PASS|FAIL|INFO) ' "$out/pty.txt" || line "FAIL pty-checks (no output)"

# Slow link: 48 KB/s and unlimited, writer on and off.
python3 -m venv "$repo/.probe-venv" && "$repo/.probe-venv/bin/pip" install -q pyte
lib=$(ls packages/native/lib/*/libopentui.dylib packages/native/lib/*/libopentui.so 2>/dev/null | head -1)
limit 1200 .github/probe/slowlink/run.sh "$repo" "$repo/$lib" "$repo/.probe-venv/bin/python" 2>&1 | tee "$out/slowlink.txt"
grep -E '^(PASS|FAIL|INFO) ' "$out/slowlink.txt" >>"$summary"
grep -qE '^(PASS|FAIL) slowlink-48k' "$out/slowlink.txt" || line "FAIL slowlink (no verdict)"
cp -R .github/probe/slowlink/runs "$out/slowlink-runs" 2>/dev/null

# Mutation: without the macOS pin every Session falls back to the synchronous drain; both pin rows
# must fail. Last, because it rebuilds the library.
git apply .github/probe/pin-off.patch
(cd packages/core && limit 900 bun run build:native) >"$out/mutation-build.txt" 2>&1
(cd packages/core && limit 300 bun test src/tests/stdout-writer-unload.test.ts) >"$out/mutation-unload.txt" 2>&1
if [ $? != 0 ]; then line "PASS mutation-pin-off-unload-test-fails"; else line "FAIL mutation-pin-off-unload-test-fails (it passed)"; fi
(cd packages/core && limit 1800 bun run test:native "-Dtest-filter=needs no pin") >"$out/mutation-native.txt" 2>&1
if [ $? != 0 ]; then line "PASS mutation-pin-off-native-test-fails"; else line "FAIL mutation-pin-off-native-test-fails (it passed)"; fi
git checkout packages/native/src/stdout-writer.zig

echo
cat "$summary"
! grep -q '^FAIL' "$summary"
