# stb_image_resize2

Pinned to commit `904aa67e1e2d1dec92959df63e700b166d5c1022`, version 2.18.

Upstream source SHA-256:
`173e654634f6ccaad98f603e686ea212eec1fe8ea6d2a5e5e8056efa10ae3880`

Patched SHA-256:
`3cfc10a3aa7287fa1f1360df360b22e63b2e3426965d7696f8b5c273bc810d55`

## Local coefficient-copy alignment fix

Upstream's scalar `STBIR_MOVE_*` coefficient-copy macros access `float` storage
through `uint32_t *` and `uint64_t *` casts. Coefficient rows can be only
4-byte aligned, so the 64-bit accesses can be unaligned and are undefined
behavior. They trapped under Zig's safety instrumentation on Apple Silicon.

`patches/stb_image_resize2-alignment.patch` replaces those scalar copies with
`memcpy`, which supports unaligned source and destination addresses. This is a
source-level correctness fix. It requires no sanitizer suppression and is
independent of the SIMD sRGB table issue below.

## Accepted SIMD sRGB bounds exception

The upstream SIMD linear-to-sRGB encoder has three lookup sites that pass
`fp32_to_srgb8_tab4 - (127-13)*8`, a pointer 912 elements before the 104-entry
table. Inputs are clamped before lookup. The resulting indexes range from 912
through 1015, so the effective reads resolve to table elements 0 through 103.
This is the upstream idiom discussed in
[`nothings/stb#1616`](https://github.com/nothings/stb/issues/1616). It does not
perform a physical read outside that table range, but forming the pre-array
pointer is outside C's array-pointer model. Zig/Clang bounds instrumentation
therefore aborts before the effective lookup can complete.

OpenTUI isolates the implementation in `image-resize-shim.c` and passes
`-fno-sanitize=bounds` only for that translation unit. Pointer-overflow,
alignment, and every other sanitizer category remain enabled when the build
enables them. In particular, do not add `pointer-overflow` to this suppression:
the recorded regression passes with pointer-overflow instrumentation enabled.
The decoder implementation remains in `image-shim.c` without this exception.

The native test `area resize upscales tiny sources exactly` covers the SIMD RGBA
sRGB path on supported native x86_64/aarch64 builds. Its `1x1 -> 12x2` case
verifies every output RGBA pixel. Its `1x1 -> 1x7` case exercises a mixed-axis
tiny resize but checks only dimensions and the first red sample. This evidence
does not cover every SIMD lookup variant, architecture, or resize path, and it
is not a general memory-safety proof.

The narrow strict-C/bounds-instrumentation exception described above is
accepted project policy. It is not a known physical out-of-range table read;
that statement applies only to these clamped lookups. Do not report the scoped
`-fno-sanitize=bounds` flag as an accidental sanitizer disablement, do not
conflate it with the resolved alignment issue, and do not broaden its scope.

To close the exception permanently:

1. Patch all three SIMD lookup sites so the pointer remains at
   `fp32_to_srgb8_tab4` and the 912-element adjustment is applied to the integer
   indexes.
2. Apply that patch reproducibly from `../update.sh` and update the patched
   SHA-256 recorded here and in the updater.
3. Remove the resize translation unit's bounds sanitizer suppression from
   `build.zig`.
4. Run `area resize upscales tiny sources exactly` with normal bounds
   instrumentation, then run `bun run test:native` and `bun run build:native`.

`stb_image.h` is pinned to commit
`f0569113c93ad095470c54bf34a17b36646bbbb5`, version 2.30, and compiled with
only its JPEG decoder enabled. SHA-256:
`594c2fe35d49488b4382dbfaec8f98366defca819d916ac95becf3e75f4200b3`.

Patched SHA-256: `1657895e86c730668cc5af6d3c8ae8f80b67c64f2ade81c44c40cee70fba555e`.

`STBI_STRICT_JPEG` is an OpenTUI-local extension that rejects streams when
decoding needs synthetic zero bits after reaching a marker or end of input.

The exact local changes are in `patches/`. Update with `bun run vendor:update:images` from `packages/core`; see `../README.md`.
