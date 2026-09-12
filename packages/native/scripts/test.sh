#!/bin/sh
set -eu

test_filter=
for argument in "$@"; do
  case "$argument" in
    -Dtest-filter=*) test_filter=$argument ;;
  esac
done

zig build test --summary all "$@"
if [ -n "$test_filter" ]; then
  (cd examples/hello && zig build test "$test_filter")
else
  (cd examples/hello && zig build test)
fi
(cd examples/hello && zig build run)
