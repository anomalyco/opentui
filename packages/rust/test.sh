#!/bin/sh
set -eu

here=$(CDPATH='' cd -- "$(dirname -- "$0")" && pwd)
usage() {
    printf '%s\n' "usage: sh $0 [all|shared|static]" >&2
    exit 2
}
[ "$#" -le 1 ] || usage
case $(uname -s)/$(uname -m) in
    Linux/x86_64) platform=x86_64-linux ;;
    Darwin/arm64) platform=aarch64-macos ;;
    Darwin/x86_64) platform=x86_64-macos ;;
    # Git Bash and other MSYS shells.
    MINGW*/x86_64 | MSYS*/x86_64) platform=x86_64-windows ;;
    *) printf '%s\n' 'SKIP: OpenTUI Rust checks support Linux x86_64, macOS, and Windows x86_64 only.' >&2; exit 77 ;;
esac
case ${1:-all} in
    all) modes='shared static' ;;
    shared|static) modes=$1 ;;
    *) usage ;;
esac
if [ "$platform" = x86_64-windows ]; then
    # Windows links opentui.dll with or without the static feature, so one pass with the default features checks both.
    modes=shared
fi
# Without OPENTUI_LIB_DIR, the crates link this checkout's packages/native/lib/$platform.
if [ -n "${OPENTUI_LIB_DIR:-}" ]; then
    # Cargo on Windows needs a Windows path, which MSYS's `pwd -W` prints.
    OPENTUI_LIB_DIR=$(CDPATH='' cd -- "$OPENTUI_LIB_DIR" && if [ "$platform" = x86_64-windows ]; then pwd -W; else pwd; fi)
    export OPENTUI_LIB_DIR
fi
cargo=${CARGO:-cargo}
manifest=$here/Cargo.toml

"$cargo" fmt --all --check --manifest-path "$manifest"
# Each crate turns on the static feature by default, and --no-default-features turns it off through every edge.
for package in opentui-sys opentui opentui-ssh; do
    for defaults in '' --no-default-features; do
        tree=$("$cargo" tree --locked --manifest-path "$manifest" -p "$package" $defaults -e features -i opentui-sys)
        case $tree in *'opentui-sys feature "static"'*) resolved=static ;; *) resolved=shared ;; esac
        case $defaults in '') expected=static ;; *) expected=shared ;; esac
        [ "$resolved" = "$expected" ] ||
            { printf 'FAIL: %s %s resolves to %s linking\n' "$package" "${defaults:-defaults}" "$resolved" >&2; exit 1; }
    done
done
for linkage in $modes; do
    features=opentui/tokio,opentui/log,opentui/tree-sitter
    # The static feature is a default one.
    defaults=
    [ "$linkage" = static ] || [ "$platform" = x86_64-windows ] || defaults=--no-default-features
    export CARGO_TARGET_DIR="$here/target/test-$linkage"
    # Without optional features, highlighting falls back to plain text. CI only lints that; the run below repeats the rest.
    if [ "$linkage" = shared ]; then
        "$cargo" clippy --locked --manifest-path "$manifest" -p opentui --all-targets $defaults -- -D warnings
        [ "${CI:-}" = true ] || "$cargo" test --locked --manifest-path "$manifest" -p opentui $defaults
    fi
    "$cargo" clippy --locked --manifest-path "$manifest" --workspace --all-targets $defaults --features "$features" \
        -- -D warnings
    "$cargo" test --locked --manifest-path "$manifest" --workspace $defaults --features "$features"
    "$cargo" build --locked --manifest-path "$manifest" -p opentui -p opentui-ssh --examples $defaults \
        --features "$features"
    RUSTDOCFLAGS='-D warnings' "$cargo" doc --locked --manifest-path "$manifest" -p opentui -p opentui-ssh --no-deps \
        $defaults --features "$features"
    # An app on opentui's features of this pass links as the pass says. Built alone, since opentui-ssh's defaults would
    # turn on the static feature too.
    if [ "$platform" = x86_64-linux ]; then
        "$cargo" build --locked --manifest-path "$manifest" -p opentui --example hello $defaults
        dynamic=$(readelf -d "$CARGO_TARGET_DIR/debug/examples/hello")
        case $dynamic in *libopentui.so*) linked=shared ;; *) linked=static ;; esac
        [ "$linked" = "$linkage" ] || { printf 'FAIL: the %s pass links %s\n' "$linkage" "$linked" >&2; exit 1; }
    fi
    # More lifecycle checks, with signals and job control, under a pseudo-terminal from Python's standard library.
    # Windows has neither, and tests/lifecycle.rs covers the exit paths it has.
    if [ "$platform" != x86_64-windows ]; then
        if command -v python3 >/dev/null 2>&1; then
            python3 "$here/scripts/pty-smoke.py" "$CARGO_TARGET_DIR/debug/examples/lifecycle"
        else
            printf '%s\n' 'SKIP: python3 is unavailable for the pseudo-terminal lifecycle checks.' >&2
        fi
    fi
    printf 'PASS: workspace checks (%s linkage)\n' "$linkage"
done
