#!/bin/sh
set -eu

here=$(CDPATH='' cd -- "$(dirname -- "$0")" && pwd)
if [ "$#" -gt 2 ]; then
    printf '%s\n' "usage: sh $0 [tasks|workbench] [shared|static]" >&2
    exit 2
fi
case $(uname -s)/$(uname -m) in
    Linux/x86_64) ;;
    *) printf '%s\n' 'SKIP: Rust app supports Linux x86_64 execution only.' >&2; exit 77 ;;
esac
example=tasks
case ${1:-} in
    tasks|workbench) example=$1; shift ;;
esac
if [ "$#" -gt 1 ]; then
    printf '%s\n' "usage: sh $0 [tasks|workbench] [shared|static]" >&2
    exit 2
fi
case ${1:-shared} in
    shared) features=terminal-example ;;
    static) features=terminal-example,static ;;
    *) printf '%s\n' "usage: sh $0 [tasks|workbench] [shared|static]" >&2; exit 2 ;;
esac
exec "${CARGO:-cargo}" run --offline --manifest-path "$here/Cargo.toml" --example "$example" --features "$features"
