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
    echo native=true
    echo core=true
    echo react=true
    echo solid=true
    echo keymap=true
    echo qrcode=true
    echo three=true
    echo ssh=true
    exit 0
fi
# --no-renames lists both paths of a moved file, and needs no file contents in a blob-less clone. Unquoted paths keep
# names with non-ASCII characters matchable.
files=$(git -c core.quotePath=false diff --name-only --no-renames "$2" "$3")
# The crates, what they link, generate from and read in tests, and the CI that tests them.
rust=false
if printf '%s\n' "$files" | grep -Eq \
    '^(packages/rust/|packages/native/|packages/core/scripts/native-abi|packages/keymap/scripts/rust-tables\.ts$|packages/core/src/tests/fixtures/video/|packages/core/src/.*\.conformance\.json$|scripts/(native-bottle\.ts|ci-changes\.sh)$|\.github/actions/|\.github/workflows/(build-core|changes)\.yml$)'; then
    rust=true
fi
# Every changed file is in the crates. An empty diff prints one empty line, which is not, so it runs everything.
rust_only=false
if ! printf '%s\n' "$files" | grep -qv '^packages/rust/'; then
    rust_only=true
fi
# The native inputs. Only a host build tests them, so a pull request that changes them runs the cross-OS matrix.
native=false
if printf '%s\n' "$files" | grep -Eq \
    '^(packages/native/|packages/core/scripts/native-abi|packages/core/src/tests/fixtures/video/|scripts/native-bottle\.ts$|\.github/workflows/(build-core|changes)\.yml$)'; then
    native=true
fi
# Every check builds and imports core, so a change to it, to the shared toolchain or to the repository configuration
# runs all of them. A framework change also runs the packages that build against it.
shared=false
if printf '%s\n' "$files" | grep -Eq \
    '^(packages/(core|native|three)/|bun\.lock$|package\.json$|\.node-version$|tsconfig[^/]*\.json$|\.github/|scripts/)'; then
    shared=true
fi
core=$shared
react=$shared
solid=$shared
keymap=$shared
qrcode=$shared
ssh=$shared
if printf '%s\n' "$files" | grep -Eq '^packages/react/'; then
    react=true
    keymap=true
    qrcode=true
    ssh=true
fi
if printf '%s\n' "$files" | grep -Eq '^packages/solid/'; then
    solid=true
    keymap=true
    qrcode=true
    ssh=true
fi
if printf '%s\n' "$files" | grep -Eq '^packages/keymap/'; then
    keymap=true
fi
if printf '%s\n' "$files" | grep -Eq '^packages/qrcode/'; then
    qrcode=true
fi
if printf '%s\n' "$files" | grep -Eq '^packages/ssh/'; then
    ssh=true
fi
echo "rust=$rust"
echo "rust_only=$rust_only"
echo "native=$native"
echo "core=$core"
echo "react=$react"
echo "solid=$solid"
echo "keymap=$keymap"
echo "qrcode=$qrcode"
echo "three=$shared"
echo "ssh=$ssh"
