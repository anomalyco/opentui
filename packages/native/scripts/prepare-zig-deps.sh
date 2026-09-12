#!/bin/sh
set -eu

ROOT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
ARCHIVE="$ROOT_DIR/src/vendor/zig-deps.tar.gz"
DEPS_DIR="$ROOT_DIR/zig-deps"
MARKER="$DEPS_DIR/.ready"
LOCK_FILE="$ROOT_DIR/.zig-deps.lock"
OWNER_FILE="$ROOT_DIR/.zig-deps.$$.owner"
TEMP_DIR="$ROOT_DIR/.zig-deps.$$.tmp"
ARCHIVE_ID=$(cksum "$ARCHIVE")

is_ready() {
  [ -f "$MARKER" ] && [ "$(cat "$MARKER")" = "$ARCHIVE_ID" ]
}

printf '%s\n' "$$" > "$OWNER_FILE"
cleanup() {
  if [ -f "$LOCK_FILE" ] && cmp -s "$OWNER_FILE" "$LOCK_FILE"; then
    rm -f "$LOCK_FILE"
  fi
  rm -rf "$OWNER_FILE" "$TEMP_DIR"
}
trap cleanup EXIT
trap 'exit 1' HUP INT TERM

attempt=0
while ! ln "$OWNER_FILE" "$LOCK_FILE" 2>/dev/null; do
  if is_ready; then
    exit 0
  fi
  lock_pid=$(cat "$LOCK_FILE" 2>/dev/null || true)
  if [ -z "$lock_pid" ]; then
    continue
  fi
  if ! kill -0 "$lock_pid" 2>/dev/null; then
    echo "error: stale Zig dependency lock; remove $LOCK_FILE" >&2
    exit 1
  fi
  attempt=$((attempt + 1))
  if [ "$attempt" -ge 30 ]; then
    echo "error: timed out waiting to prepare Zig dependencies" >&2
    exit 1
  fi
  sleep 1
done

if is_ready; then
  exit 0
fi

mkdir -p "$TEMP_DIR"
tar -xzf "$ARCHIVE" -C "$TEMP_DIR"
printf '%s\n' "$ARCHIVE_ID" > "$TEMP_DIR/.ready"
rm -rf "$DEPS_DIR"
mv "$TEMP_DIR" "$DEPS_DIR"
