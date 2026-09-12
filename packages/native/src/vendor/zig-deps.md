# Zig dependencies

The repository contains `zig-deps.tar.gz`, so native commands do not use remote package servers.
The package scripts extract the archive to the ignored `packages/native/zig-deps` directory.

Run `bun run vendor:update:zig` from `packages/core` to create the archive from pinned upstream sources.
The update script checks each download and applies the OpenTUI changes in `vendor/zig-deps`.
It removes unused source and creates a deterministic archive.
The script requires `curl`, `git`, GNU `tar`, `gzip`, and either `sha256sum` or `shasum`.

The pin and checksum variables in `update-zig-deps.sh` are the source of truth for dependency versions.

The Ghostty archive contains only source that `ghostty-vt` needs.
It excludes large font fixtures, tests, examples, applications, and unrelated C libraries.
Its manifest omits unrelated application dependencies.
Its build file exports only the Zig VT modules.
The change to `src/build/SharedDeps.zig` removes unused GUI frame data.
The Yoga archive contains only the `yoga` source directory.

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
