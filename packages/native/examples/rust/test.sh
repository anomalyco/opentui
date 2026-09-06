#!/bin/sh
set -eu

here=$(CDPATH='' cd -- "$(dirname -- "$0")" && pwd)
if [ "$#" -gt 1 ]; then
    printf '%s\n' "usage: sh $0 [all|shared|static]" >&2
    exit 2
fi
case $(uname -s)/$(uname -m) in
    Linux/x86_64) ;;
    *) printf '%s\n' 'SKIP: Rust binding checks support Linux x86_64 execution only.' >&2; exit 77 ;;
esac
case ${1:-all} in
    all) modes='shared static' ;;
    shared|static) modes=$1 ;;
    *) printf '%s\n' "usage: sh $0 [all|shared|static]" >&2; exit 2 ;;
esac
library=${OPENTUI_LIB_DIR:-"$here/../../lib/x86_64-linux"}
library=$(CDPATH='' cd -- "$library" && pwd)
export OPENTUI_LIB_DIR="$library"
export LD_LIBRARY_PATH="$library${LD_LIBRARY_PATH:+:$LD_LIBRARY_PATH}"
cargo=${CARGO:-cargo}
rustc=${RUSTC:-rustc}
work=$(mktemp -d "${TMPDIR:-$here}/rust-tests.XXXXXXXX")
trap 'rm -rf -- "$work"' EXIT HUP INT TERM
export CARGO_TARGET_DIR="$work/target"

for linkage in $modes; do
    case $linkage in
        shared) features=terminal-example ;;
        static) features=terminal-example,static ;;
    esac
    "$cargo" test --offline --manifest-path "$here/Cargo.toml" --features "$features" -- --test-threads=1
    "$cargo" build --offline --manifest-path "$here/Cargo.toml" --features "$features" --lib --examples
    # A separate consumer must link and run using only the binding's rlib metadata.
    "$rustc" --edition=2021 -D warnings "$here/tests/ownership.rs" \
        --extern "opentui=$CARGO_TARGET_DIR/debug/libopentui.rlib" \
        -L "native=$library" -L "dependency=$CARGO_TARGET_DIR/debug/deps" -o "$work/consumer"
    "$work/consumer"
    printf 'PASS: Rust binding and external consumer (%s linkage)\n' "$linkage"
done

for case in context_dropped_first session_dropped_first context_send context_sync session_send session_sync node_send node_sync; do
    if "$rustc" --edition=2021 --emit=metadata --cfg "$case" "$here/tests/ownership.rs" \
        --extern "opentui=$CARGO_TARGET_DIR/debug/libopentui.rlib" \
        -L "dependency=$CARGO_TARGET_DIR/debug/deps" -o "$work/ownership.rmeta" 2>"$work/$case.stderr"; then
        printf 'FAIL: ownership fixture unexpectedly compiled: %s\n' "$case" >&2
        exit 1
    fi
    case $case in
        *_dropped_first) grep -q 'error\[E0505\]' "$work/$case.stderr" ;;
        *) grep -q 'error\[E0277\]' "$work/$case.stderr" ;;
    esac
    printf 'PASS: compiler rejects %s\n' "$case"
done
