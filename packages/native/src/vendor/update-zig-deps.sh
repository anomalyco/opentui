#!/bin/sh
set -eu

VENDOR_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
OUTPUT="$VENDOR_DIR/zig-deps.tar.gz"
OUTPUT_TMP="$OUTPUT.$$.tmp"

GHOSTTY_COMMIT=727b8a02f8734840de664c060678dd66f01931f6
GHOSTTY_SHA256=1cdde6bd3c1071de0f4ba489ee526361045e967170e8b50ca6f1d3fe0c624adf
UUCODE_GHOSTTY_COMMIT=2826a37a4562284fdacd8fa029d49509cc9bffcd
UUCODE_GHOSTTY_SHA256=7e76fc7fab1e7ac728c52b35bbb3e5b8c639841abfc7fe1a4bcb13050594bc9e
UUCODE_OPENTUI_COMMIT=8ad04b756f85a5ba1ac8d2b8cb48d0946f06b630
UUCODE_OPENTUI_SHA256=f1ce9f0038c46cc75fdd4e8469baac0dce60e20517d8d32ed813bfa9906fefc2
YOGA_VERSION=3.2.1
YOGA_SHA256=86b399ac31fd820d8ffa823c3fae31bb690b6fc45301b2a8a966c09b5a088b55

for command_name in curl git gzip tar; do
  command -v "$command_name" >/dev/null 2>&1 || {
    echo "error: required command not found: $command_name" >&2
    exit 1
  }
done

if command -v sha256sum >/dev/null 2>&1; then
  sha256_file() { sha256sum "$1" | cut -d ' ' -f 1; }
elif command -v shasum >/dev/null 2>&1; then
  sha256_file() { shasum -a 256 "$1" | cut -d ' ' -f 1; }
else
  echo "error: sha256sum or shasum is required" >&2
  exit 1
fi

download() {
  url=$1
  output=$2
  expected=$3
  echo "Downloading $url"
  curl -fsSL --retry 3 --retry-delay 1 "$url" -o "$output"
  actual=$(sha256_file "$output")
  if [ "$actual" != "$expected" ]; then
    echo "error: SHA-256 mismatch for $url" >&2
    echo "expected: $expected" >&2
    echo "actual:   $actual" >&2
    exit 1
  fi
}

extract() {
  archive=$1
  destination=$2
  mkdir -p "$destination"
  tar -xzf "$archive" --strip-components=1 -C "$destination"
}

TMP_DIR=$(mktemp -d "${TMPDIR:-/tmp}/opentui-zig-vendor.XXXXXX")
cleanup() {
  rm -rf "$TMP_DIR"
  rm -f "$OUTPUT_TMP"
}
trap cleanup EXIT
trap 'exit 1' HUP INT TERM
SOURCE_DIR="$TMP_DIR/source"
DEPS_DIR="$TMP_DIR/zig-deps"

download "https://github.com/ghostty-org/ghostty/archive/$GHOSTTY_COMMIT.tar.gz" "$TMP_DIR/ghostty.tar.gz" "$GHOSTTY_SHA256"
download "https://github.com/jacobsandlund/uucode/archive/$UUCODE_GHOSTTY_COMMIT.tar.gz" "$TMP_DIR/uucode-ghostty.tar.gz" "$UUCODE_GHOSTTY_SHA256"
download "https://github.com/jacobsandlund/uucode/archive/$UUCODE_OPENTUI_COMMIT.tar.gz" "$TMP_DIR/uucode-opentui.tar.gz" "$UUCODE_OPENTUI_SHA256"
download "https://github.com/facebook/yoga/archive/refs/tags/v$YOGA_VERSION.tar.gz" "$TMP_DIR/yoga.tar.gz" "$YOGA_SHA256"

extract "$TMP_DIR/ghostty.tar.gz" "$SOURCE_DIR/ghostty"
mkdir -p "$DEPS_DIR/ghostty/pkg"
cp "$SOURCE_DIR/ghostty/LICENSE" "$DEPS_DIR/ghostty/LICENSE"
cp -R "$SOURCE_DIR/ghostty/include" "$SOURCE_DIR/ghostty/src" "$DEPS_DIR/ghostty/"
rm -rf "$DEPS_DIR/ghostty/src/font/res"
cp -R "$SOURCE_DIR/ghostty/pkg/android-ndk" "$SOURCE_DIR/ghostty/pkg/apple-sdk" "$DEPS_DIR/ghostty/pkg/"
cp "$VENDOR_DIR/zig-deps/ghostty-build.zig" "$DEPS_DIR/ghostty/build.zig"
cp "$VENDOR_DIR/zig-deps/ghostty-build.zig.zon" "$DEPS_DIR/ghostty/build.zig.zon"
git -C "$DEPS_DIR/ghostty" apply "$VENDOR_DIR/zig-deps/ghostty-shared-deps.patch"

for name in uucode-ghostty uucode-opentui; do
  extract "$TMP_DIR/$name.tar.gz" "$SOURCE_DIR/$name"
  mkdir -p "$DEPS_DIR/$name"
  cp -R "$SOURCE_DIR/$name/LICENSE.md" "$SOURCE_DIR/$name/build.zig" "$SOURCE_DIR/$name/build.zig.zon" \
    "$SOURCE_DIR/$name/src" "$SOURCE_DIR/$name/ucd" "$DEPS_DIR/$name/"
done

extract "$TMP_DIR/yoga.tar.gz" "$SOURCE_DIR/yoga"
mkdir -p "$DEPS_DIR/yoga"
cp "$SOURCE_DIR/yoga/LICENSE" "$DEPS_DIR/yoga/LICENSE"
cp -R "$SOURCE_DIR/yoga/yoga" "$DEPS_DIR/yoga/yoga"

find "$DEPS_DIR" -type d -exec chmod 0755 {} +
find "$DEPS_DIR" -type f -exec chmod 0644 {} +
ARCHIVE="$TMP_DIR/zig-deps.tar"
tar --sort=name --mtime='UTC 2020-01-01' --owner=0 --group=0 --numeric-owner -C "$DEPS_DIR" \
  -cf "$ARCHIVE" ghostty uucode-ghostty uucode-opentui yoga
gzip -n -9 "$ARCHIVE"
cp "$ARCHIVE.gz" "$OUTPUT_TMP"
mv "$OUTPUT_TMP" "$OUTPUT"

echo "Updated $OUTPUT"
