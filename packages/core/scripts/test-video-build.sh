#!/bin/sh
# Pass the two unstripped host libraries: the default build and zig build -Dvideo=false.
set -eu
[ "$#" -eq 2 ] || { echo "usage: $0 DEFAULT_LIBRARY NO_VIDEO_LIBRARY" >&2; exit 2; }
check_symbols() {
  symbols=$(nm -P "$1")
  printf '%s\n' "$symbols" | awk -v library="$1" -v enabled="$2" '
    $1 ~ /^_?otv_open$/ { shim = 1 }
    $1 ~ /^_?(avcodec_|avformat_|swscale|sws_|swr_|av_)/ { count++ }
    END { print library ": " count+0 " FFmpeg symbols"; exit !(shim && (count > 0) == enabled) }'
}
check_symbols "$1" 1
check_symbols "$2" 0
OPENTUI_LIB_PATH="$2" OPENTUI_TEST_NO_VIDEO=1 bun test src/tests/video-renderable.test.ts -t 'open failures report the native detail'
if (cd ../native && zig build -Drequire-video -Dvideo=false --help >/dev/null); then
  echo 'Expected -Drequire-video to reject -Dvideo=false' >&2; exit 1
fi
