# opentui-sys

Raw FFI declarations for [OpenTUI](https://opentui.com)'s checked C ABI
(`opentui.h`), generated from the header. The safe API is
[`opentui`](https://crates.io/crates/opentui); most apps never use this crate
directly. Versions 0.9.4 and 0.9.5 were published as `anomalyco-opentui-sys`.

## The native library

The crate links OpenTUI's native library but does not build it. Download
`opentui-native-v<version>-<platform>.zip` from the
[GitHub release](https://github.com/anomalyco/opentui/releases) with the same
version as the crate, extract it into a directory of its own, and set
`OPENTUI_LIB_DIR` to that directory's absolute path. The build fails if the
archive's `opentui.h` differs from the header the declarations were generated
from. [Install, link, and ship](https://opentui.com/docs/bindings/rust/install)
has the details.

## Licenses

The crate's code is MIT-licensed, and it holds no FFmpeg code. The native
library it links does: the release archives' library statically includes a
decode-only FFmpeg build, licensed under LGPL-2.1-or-later, even if your app
never plays video. The crate's license, `MIT AND LGPL-2.1-or-later`, names
both, because the default build links that library into your program.

An app that links the release library statically, or ships `opentui.dll`,
must ship the release archive's notices with it: `LICENSE-FFMPEG`,
`FFMPEG-SOURCE.md` (the exact FFmpeg source, and how to rebuild and relink the
library with a modified FFmpeg), and the other `LICENSE-*` files. This crate
carries copies of the FFmpeg, zlib, Yoga, Zig, LLVM, MinGW-w64, and gdtoa
notices.

To ship without FFmpeg, build the native library without video in a checkout
of OpenTUI at the crate's release tag, and point `OPENTUI_LIB_DIR` at it:

```sh
cd packages/native
sh scripts/prepare-zig-deps.sh
zig build -Dvideo=false -Doptimize=ReleaseFast
```

The result is in `packages/native/lib/<artifact directory>`; opening a video
then reports that decoding is unavailable.
