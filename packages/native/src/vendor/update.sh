#!/bin/sh
set -eu

VENDOR_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
WUFFS_DIR="$VENDOR_DIR/wuffs"
STB_DIR="$VENDOR_DIR/stb"
LIBWEBP_DIR="$VENDOR_DIR/libwebp"
LCMS2_DIR="$VENDOR_DIR/lcms2"

WUFFS_COMMIT=ec71f9c6d829ca763fbbc1f7adecc30a89a8ed0a
WUFFS_SHA256=a3db4bd979663423de00309d1ba07d7fa8576845223d3e02764181bd6da23f90

STB_IMAGE_COMMIT=f0569113c93ad095470c54bf34a17b36646bbbb5
STB_IMAGE_UPSTREAM_SHA256=594c2fe35d49488b4382dbfaec8f98366defca819d916ac95becf3e75f4200b3
STB_IMAGE_PATCHED_SHA256=1657895e86c730668cc5af6d3c8ae8f80b67c64f2ade81c44c40cee70fba555e
STB_RESIZE_COMMIT=904aa67e1e2d1dec92959df63e700b166d5c1022
STB_RESIZE_UPSTREAM_SHA256=173e654634f6ccaad98f603e686ea212eec1fe8ea6d2a5e5e8056efa10ae3880
STB_RESIZE_PATCHED_SHA256=3cfc10a3aa7287fa1f1360df360b22e63b2e3426965d7696f8b5c273bc810d55

LIBWEBP_VERSION=1.6.0
LIBWEBP_ARCHIVE_SHA256=e4ab7009bf0629fd11982d4c2aa83964cf244cffba7347ecd39019a9e38c4564

LCMS2_VERSION=2.19.1
LCMS2_ARCHIVE_SHA256=bfc54f7bab59fbc921012014a8032e4cba4abd46db47d46b76416a8c0b2815c8

for command_name in curl git tar; do
  command -v "$command_name" >/dev/null 2>&1 || {
    echo "error: required command not found: $command_name" >&2
    exit 1
  }
done

REPO_ROOT=$(git -C "$VENDOR_DIR" rev-parse --show-toplevel)
STB_PREFIX=$(git -C "$STB_DIR" rev-parse --show-prefix)

if command -v sha256sum >/dev/null 2>&1; then
  sha256_file() { sha256sum "$1" | cut -d ' ' -f 1; }
elif command -v shasum >/dev/null 2>&1; then
  sha256_file() { shasum -a 256 "$1" | cut -d ' ' -f 1; }
else
  echo "error: sha256sum or shasum is required" >&2
  exit 1
fi

verify_sha256() {
  file=$1
  expected=$2
  actual=$(sha256_file "$file")
  if [ "$actual" != "$expected" ]; then
    echo "error: SHA-256 mismatch for $file" >&2
    echo "expected: $expected" >&2
    echo "actual:   $actual" >&2
    exit 1
  fi
}

download() {
  url=$1
  output=$2
  echo "Downloading $url"
  curl -fsSL --retry 3 --retry-delay 1 "$url" -o "$output"
}

TMP_ROOT=${TMPDIR:-/tmp}
TMP_DIR=$(mktemp -d "$TMP_ROOT/opentui-image-vendor.XXXXXX")
trap 'rm -rf "$TMP_DIR"' EXIT HUP INT TERM

echo "Updating Wuffs"
download "https://raw.githubusercontent.com/google/wuffs/$WUFFS_COMMIT/release/c/wuffs-v0.3.c" "$TMP_DIR/wuffs-v0.3.c"
download "https://raw.githubusercontent.com/google/wuffs/$WUFFS_COMMIT/LICENSE" "$TMP_DIR/wuffs-LICENSE"
verify_sha256 "$TMP_DIR/wuffs-v0.3.c" "$WUFFS_SHA256"
cp "$TMP_DIR/wuffs-v0.3.c" "$WUFFS_DIR/wuffs-v0.3.c"
cp "$TMP_DIR/wuffs-LICENSE" "$WUFFS_DIR/LICENSE"

echo "Updating stb"
download "https://raw.githubusercontent.com/nothings/stb/$STB_IMAGE_COMMIT/stb_image.h" "$TMP_DIR/stb_image.h"
download "https://raw.githubusercontent.com/nothings/stb/$STB_RESIZE_COMMIT/stb_image_resize2.h" "$TMP_DIR/stb_image_resize2.h"
download "https://raw.githubusercontent.com/nothings/stb/$STB_IMAGE_COMMIT/LICENSE" "$TMP_DIR/stb-LICENSE"
verify_sha256 "$TMP_DIR/stb_image.h" "$STB_IMAGE_UPSTREAM_SHA256"
verify_sha256 "$TMP_DIR/stb_image_resize2.h" "$STB_RESIZE_UPSTREAM_SHA256"
cp "$TMP_DIR/stb_image.h" "$STB_DIR/stb_image.h"
cp "$TMP_DIR/stb_image_resize2.h" "$STB_DIR/stb_image_resize2.h"
cp "$TMP_DIR/stb-LICENSE" "$STB_DIR/LICENSE"
git -C "$REPO_ROOT" apply --whitespace=nowarn --directory="$STB_PREFIX" "$STB_DIR/patches/stb_image-strict-jpeg.patch"
git -C "$REPO_ROOT" apply --whitespace=nowarn --directory="$STB_PREFIX" "$STB_DIR/patches/stb_image_resize2-alignment.patch"
verify_sha256 "$STB_DIR/stb_image.h" "$STB_IMAGE_PATCHED_SHA256"
verify_sha256 "$STB_DIR/stb_image_resize2.h" "$STB_RESIZE_PATCHED_SHA256"

echo "Updating libwebp"
LIBWEBP_ARCHIVE="$TMP_DIR/libwebp-$LIBWEBP_VERSION.tar.gz"
download "https://storage.googleapis.com/downloads.webmproject.org/releases/webp/libwebp-$LIBWEBP_VERSION.tar.gz" "$LIBWEBP_ARCHIVE"
verify_sha256 "$LIBWEBP_ARCHIVE" "$LIBWEBP_ARCHIVE_SHA256"
tar -xzf "$LIBWEBP_ARCHIVE" -C "$TMP_DIR"
LIBWEBP_SOURCE="$TMP_DIR/libwebp-$LIBWEBP_VERSION"
rm -rf "$LIBWEBP_DIR/src"
while IFS= read -r path; do
  [ -n "$path" ] || continue
  mkdir -p "$LIBWEBP_DIR/${path%/*}"
  cp "$LIBWEBP_SOURCE/$path" "$LIBWEBP_DIR/$path"
done < "$LIBWEBP_DIR/FILES"
cp "$LIBWEBP_SOURCE/COPYING" "$LIBWEBP_DIR/COPYING"
cp "$LIBWEBP_SOURCE/PATENTS" "$LIBWEBP_DIR/PATENTS"
cp "$LIBWEBP_SOURCE/AUTHORS" "$LIBWEBP_DIR/AUTHORS"

echo "Updating Little CMS"
LCMS2_ARCHIVE="$TMP_DIR/lcms2-$LCMS2_VERSION.tar.gz"
download "https://github.com/mm2/Little-CMS/releases/download/lcms$LCMS2_VERSION/lcms2-$LCMS2_VERSION.tar.gz" "$LCMS2_ARCHIVE"
verify_sha256 "$LCMS2_ARCHIVE" "$LCMS2_ARCHIVE_SHA256"
tar -xzf "$LCMS2_ARCHIVE" -C "$TMP_DIR"
LCMS2_SOURCE="$TMP_DIR/lcms2-$LCMS2_VERSION"
rm -rf "$LCMS2_DIR/include" "$LCMS2_DIR/src"
while IFS= read -r path; do
  [ -n "$path" ] || continue
  mkdir -p "$LCMS2_DIR/${path%/*}"
  cp "$LCMS2_SOURCE/$path" "$LCMS2_DIR/$path"
done < "$LCMS2_DIR/FILES"
cp "$LCMS2_SOURCE/LICENSE" "$LCMS2_DIR/LICENSE"

echo "Image vendors updated successfully. Review the git diff, then run bun run test:native."
