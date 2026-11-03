# Zig dependencies

The repository contains `zig-deps.tar.gz`, so native commands do not use remote package servers.
The package scripts extract the archive to the ignored `packages/native/zig-deps` directory.

Run `bun run vendor:update:zig` from `packages/core` to create the archive from pinned upstream sources.
The update script checks each download and applies the OpenTUI changes in `vendor/zig-deps`.
It removes unused source, creates a deterministic archive, and writes `zig-deps.sha256`.
The script requires `curl`, `git`, GNU `tar`, `gzip`, and either `sha256sum` or `shasum`.

The pin and checksum variables in `update-zig-deps.sh` are the source of truth for dependency versions.

The Ghostty archive keeps `include`, `src` without `src/font/res`, and the `pkg/android-ndk` and `pkg/apple-sdk` packages.
It excludes large font fixtures, tests, examples, applications, and unrelated C libraries.
Its manifest omits unrelated application dependencies.
Its build file exports only the Zig VT modules.
The change to `src/build/SharedDeps.zig` removes unused GUI frame data.
The Ghostty pin supports Zig 0.16. `ghostty-zig-0.17.patch` makes it compile on Zig 0.17, applied after
`ghostty-shared-deps.patch`. It changes only what Zig 0.17 rejects: array multiplication, removed standard
library names, and the new reflection fields. Ghostty's own Zig 0.17 port (ghostty-org/ghostty#14519) landed
in commit `3d07ef9`, after the pin, and makes the same kind of changes. Remove the patch when the pin moves
to that commit or later.
The OpenTUI uucode copy uses commit `d500967`, a Zig 0.17 port of commit `2826a37`, which contains the former
pin `8ad04b7`. The Ghostty copy uses commit `ea62149`, a Zig 0.17 port of Ghostty's uucode pin, `9d55524`.
Both ports change only Zig code, and the update script gives both copies the same Unicode data, so the
generated tables do not change.
The Yoga archive contains only the `yoga` source directory.

The Yoga source is upstream Yoga 3.2.1 with seven changes, applied in this order:

- `yoga-error-boundary.patch` routes every Yoga allocation through `yoga/OTAllocator.h`, so a test build can
  inject allocation failures. It also makes style updates, child insertion, and child moves leave the node
  unchanged when an allocation fails. The checked bridge in `src/yoga-bridge.cpp` depends on this.
- `yoga-cache-rounding.patch` rounds an axis in the layout cache check only when that axis can match. The
  cache decision stays the same.
- `yoga-node-reuse.patch` keeps a reset node's child storage for reuse, and resets the count of
  `display: contents` children when all children are removed.
- `yoga-absolute-edge-rounding.patch` adds a config option that rounds each node's position from the same
  absolute edges that Yoga already uses for its size. Upstream rounds the relative position on its own,
  so a child nested under fractional offsets can end one cell outside its parent. With the option, the
  layout cache also compares available sizes exactly, because a subtree laid out for one fractional size
  rounds differently at another size that rounds to the same cell. Only the scene's config in
  `src/context.zig` sets the option; other configs keep upstream rounding and caching.
- `yoga-finite-percent.patch` clamps a resolved percentage to ±1e30, so a deep percentage chain cannot
  overflow f32 and stop layout on an indefinite available size.
- `yoga-measure-height-cap.patch` lets a node mark its measure function as one that uses an "at most"
  height only to clamp its result. Where Yoga would call such a function again because the cap grew,
  it takes a cached size that was below the old cap at the same width, and stores it as a call's
  result, so later cache decisions are the same as without the patch. A node with a percent margin,
  padding, or minimum or maximum size keeps calling: no cache entry records the owner size. The native
  text and editor measures set the mark; host measures do not.
- `yoga-cache-margin.patch` subtracts the margin from the old size too in the cache's "stricter size" rule
  (upstream PR facebook/yoga#1965). Upstream compares the new size without the margin with the old size
  with it, so a measured node that grew by less than its margin kept its old size. Unlike #1965, only a
  positive margin comes off the old size: a percent margin follows an owner size that no cache entry
  records, so a negative one would accept a stale size. Upstream's rule is already valid for a negative
  margin. Upstream fixes the owner size separately in facebook/yoga#2042.

`src/tests/yoga_test.zig` tests each change.

`zig-deps.sha256` records the SHA-256 of the archive, `update-zig-deps.sh`, and each file in `zig-deps`.
`bun run test:native` fails if one of these files changes without a new archive.

## Update the Dependencies

1. Change the applicable pin and checksum variables in `update-zig-deps.sh`.
2. Make sure that each dependency archive contains its license.
3. Keep only the source files that the native build needs.
4. Run these commands from the repository root:

```sh
cd packages/core
bun run vendor:update:zig
rm -rf ../native/.zig-cache ../native/zig-pkg ../native/zig-deps
bun run test:native
bun run build:native --all
```
