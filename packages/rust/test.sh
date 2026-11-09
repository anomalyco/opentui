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
    if [ "$modes" = static ]; then
        printf '%s\n' 'SKIP: static linking is not supported on Windows.' >&2
        exit 77
    fi
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
for linkage in $modes; do
    case $linkage in
        shared) features=opentui/tokio,opentui/log,opentui/tree-sitter ;;
        static) features=opentui/static,opentui/tokio,opentui/log,opentui/tree-sitter ;;
    esac
    export CARGO_TARGET_DIR="$here/target/test-$linkage"
    # Without optional features, highlighting falls back to plain text. CI only lints that; the run below repeats the rest.
    if [ "$linkage" = shared ]; then
        "$cargo" clippy --locked --manifest-path "$manifest" -p opentui --all-targets -- -D warnings
        [ "${CI:-}" = true ] || "$cargo" test --locked --manifest-path "$manifest" -p opentui
    fi
    "$cargo" clippy --locked --manifest-path "$manifest" --workspace --all-targets ${features:+--features "$features"} \
        -- -D warnings
    "$cargo" test --locked --manifest-path "$manifest" --workspace ${features:+--features "$features"}
    "$cargo" build --locked --manifest-path "$manifest" -p opentui -p opentui-ssh --examples \
        ${features:+--features "$features"}
    RUSTDOCFLAGS='-D warnings' "$cargo" doc --locked --manifest-path "$manifest" -p opentui -p opentui-ssh --no-deps \
        ${features:+--features "$features"}
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
