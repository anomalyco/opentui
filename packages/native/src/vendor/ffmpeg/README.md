# FFmpeg

Native video statically links a minimal decode-only FFmpeg 9.0.2 build: MOV/MP4 demuxing, H.264 video decoding,
AAC audio decoding, file I/O, libswscale, and libswresample. On macOS it also enables VideoToolbox H.264 hardware
decoding, which playback uses only when the experimental `OPENTUI_EXPERIMENTAL_VIDEO_HWACCEL=1` is set. GPL and nonfree
components are disabled.

- Source: https://ffmpeg.org/releases/ffmpeg-9.0.2.tar.xz
- SHA-256: `8c3850283eb25fa026482078a04051e0be17347b09ef81a0849bec15a96e002e`
- License: LGPL-2.1-or-later (`COPYING.LGPLv2.1`)
- zlib 1.3.2: https://zlib.net/fossils/zlib-1.3.2.tar.gz
- zlib SHA-256: `bb329a0a2cd0274d05519d61c667c062e06990d72e125ee2dfa8de64f0119d16`
- zlib license: `LICENSE-ZLIB`
- NASM 3.02 (build tool for the x86_64 SIMD assembly; not linked): https://www.nasm.us/pub/nasm/releasebuilds/3.02/nasm-3.02.tar.xz

`packages/native/scripts/build-ffmpeg.ts` holds the exact build configuration and runs before every native build. It
caches the static libraries under `packages/native/.cache/ffmpeg`. Run `bun scripts/build-ffmpeg.ts --all` in
`packages/native` to build every release target. One build runs at a time; a lock left by a killed build must be
removed by hand, as the error says.

Targets that FFmpeg does not support compile video as unavailable. A supported target whose prefix is missing also
builds without video, with a warning; `-Drequire-video` makes it an error. Release builds (`build.ts --all`) and CI
native tests pass it.

FFmpeg's configure and make need a POSIX host, so Windows hosts do not build FFmpeg. Cross-build the prefix on Linux or
macOS with `bun scripts/build-ffmpeg.ts --target=x86_64-windows` and copy
`.cache/ffmpeg/prefix/x86_64-windows` to the same place on the Windows host, or download the
`ffmpeg-x86_64-windows` artifact of a Build Core CI run. Without it, Windows builds have no video and native video
tests fail.

The FFmpeg source is unmodified; OpenTUI integrates it only through `src/video-shim.c`. The OpenTUI source, the build
script, and the pinned FFmpeg source provide what is needed to rebuild and relink `libopentui` with a modified FFmpeg.
