#!/bin/sh
# Compile-checks the workspace for Windows from another system: clippy for x86_64-pc-windows-msvc with the tokio and
# log features. Nothing is linked or run; on Windows, run test.sh from Git Bash. Without the tree-sitter feature no C
# code is compiled, so no Microsoft toolchain is needed. opentui-ssh is left out: its cryptography library, ring,
# compiles C even for a check, and the crate has no Windows-specific code of its own.
#
# Needs the standard library's source (rustup's rust-src component, or a distribution's rust-src package), which
# -Zbuild-std compiles for the target. RUSTC_BOOTSTRAP lets a stable toolchain take that flag. The first run
# downloads the standard library's dependencies.
#
# Usage: OPENTUI_ROOT=/path/to/opentui sh scripts/check-windows.sh
set -eu

here=$(CDPATH='' cd -- "$(dirname -- "$0")/.." && pwd)
# The bindings match the header of built artifacts, which every platform's build shares.
if [ -n "${OPENTUI_LIB_DIR:-}" ]; then
    header=$OPENTUI_LIB_DIR/opentui.h
elif [ -n "${OPENTUI_ROOT:-}" ]; then
    header=$(ls "$OPENTUI_ROOT"/packages/native/lib/*/opentui.h 2>/dev/null | head -n 1)
fi
if [ ! -f "${header:-}" ]; then
    printf '%s\n' 'Set OPENTUI_ROOT to an OpenTUI checkout with built artifacts, or OPENTUI_LIB_DIR to one of them.' >&2
    exit 2
fi

export CARGO_TARGET_DIR="$here/target/check-windows"
# build.rs only checks that the artifacts exist and that the header matches the bindings.
stub=$CARGO_TARGET_DIR/stub
mkdir -p "$stub"
cp "$header" "$stub/opentui.h"
: > "$stub/opentui.dll"
: > "$stub/opentui.lib"

export RUSTC_BOOTSTRAP=1 OPENTUI_LIB_DIR="$stub"
cargo=${CARGO:-cargo}
for features in '' opentui/tokio,opentui/log; do
    "$cargo" clippy -Zbuild-std --target x86_64-pc-windows-msvc --manifest-path "$here/Cargo.toml" --workspace \
        --exclude opentui-ssh --all-targets ${features:+--features "$features"} -- -D warnings
done
printf '%s\n' 'PASS: Windows compile checks (x86_64-pc-windows-msvc)'
