#!/bin/sh
# Prints the outputs of .github/workflows/changes.yml as name=value lines.
#
# Usage: sh scripts/ci-changes.sh <event name> <base> <head>
#
# On a pull request, the changed files are those between base and head. Any other event (a push) runs everything.
set -eu

if [ "$1" != pull_request ]; then
    echo rust=true
    echo rust_only=false
    exit 0
fi
# --no-renames lists both paths of a moved file, and needs no file contents in a blob-less clone. Unquoted paths keep
# names with non-ASCII characters matchable.
files=$(git -c core.quotePath=false diff --name-only --no-renames "$2" "$3")
# The crates, what they link and generate from, and the CI that tests them.
rust=false
if printf '%s\n' "$files" | grep -Eq \
    '^(packages/rust/|packages/native/|packages/core/scripts/native-abi|scripts/(native-bottle\.ts|ci-changes\.sh)$|\.github/actions/|\.github/workflows/(build-core|changes)\.yml$)'; then
    rust=true
fi
# Every changed file is in the crates. An empty diff prints one empty line, which is not, so it runs everything.
rust_only=false
if ! printf '%s\n' "$files" | grep -qv '^packages/rust/'; then
    rust_only=true
fi
echo "rust=$rust"
echo "rust_only=$rust_only"
