#!/bin/sh
set -eu

here=$(CDPATH='' cd -- "$(dirname -- "$0")" && pwd)
usage() {
    printf '%s\n' "usage: sh $0 [hello|showcase|effects|tasks|native|workbench|lifecycle|terminal|split|video|chat] [shared|static]" >&2
    exit 2
}
case $(uname -s)/$(uname -m) in
    Linux/x86_64) platform=x86_64-linux ;;
    Darwin/arm64) platform=aarch64-macos ;;
    Darwin/x86_64) platform=x86_64-macos ;;
    # Git Bash and other MSYS shells.
    MINGW*/x86_64 | MSYS*/x86_64) platform=x86_64-windows ;;
    *) printf '%s\n' 'SKIP: OpenTUI Rust examples support Linux x86_64, macOS, and Windows x86_64 only.' >&2; exit 77 ;;
esac
example=hello
package=opentui
case ${1:-} in
    hello|showcase|effects|tasks|native|workbench|lifecycle|terminal|split|video) example=$1; shift ;;
    # An SSH chat server on 127.0.0.1:2222; connect with `ssh -p 2222 localhost`.
    chat) example=chat; package=opentui-ssh; shift ;;
esac
[ "$#" -le 1 ] || usage
case ${1:-shared} in
    shared) features=opentui/tree-sitter ;;
    static) features=opentui/static,opentui/tree-sitter ;;
    *) usage ;;
esac
if [ "$platform" = x86_64-windows ] && [ "${1:-shared}" = static ]; then
    printf '%s\n' 'Static linking is not supported on Windows.' >&2
    exit 2
fi
# Without OPENTUI_LIB_DIR, the crates link this checkout's packages/native/lib/$platform.
if [ -n "${OPENTUI_LIB_DIR:-}" ]; then
    # Cargo on Windows needs a Windows path, which MSYS's `pwd -W` prints.
    OPENTUI_LIB_DIR=$(CDPATH='' cd -- "$OPENTUI_LIB_DIR" && if [ "$platform" = x86_64-windows ]; then pwd -W; else pwd; fi)
    export OPENTUI_LIB_DIR
fi
exec "${CARGO:-cargo}" run --locked --manifest-path "$here/Cargo.toml" -p "$package" --example "$example" \
    ${features:+--features "$features"}
