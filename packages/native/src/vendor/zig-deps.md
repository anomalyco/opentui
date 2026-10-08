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
The Yoga archive contains only the `yoga` source directory.

The Yoga source is upstream Yoga 3.2.1 with three changes, applied in this order:

- `yoga-error-boundary.patch` routes every Yoga allocation through `yoga/OTAllocator.h`, so a test build can
  inject allocation failures. It also makes style updates, child insertion, and child moves leave the node
  unchanged when an allocation fails. The checked bridge in `src/yoga-bridge.cpp` depends on this.
- `yoga-cache-rounding.patch` rounds an axis in the layout cache check only when that axis can match. The
  cache decision stays the same.
- `yoga-node-reuse.patch` keeps a reset node's child storage for reuse, and resets the count of
  `display: contents` children when all children are removed.

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
