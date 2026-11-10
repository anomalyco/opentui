#!/bin/sh
set -eu

# An unfiltered run also runs the C context test against both libraries.
test_filter=
test_abi=test-abi
for argument in "$@"; do
  case "$argument" in
    -Dtest-filter=*) test_filter=$argument test_abi= ;;
  esac
done

sh src/vendor/update-zig-deps.sh --check
zig build test $test_abi --summary all "$@"
if [ -n "$test_filter" ]; then
  (cd examples/hello && zig build test "$test_filter")
else
  (cd examples/hello && zig build test)
fi
(cd examples/hello && zig build run)
