# Image vendors

Run the updater from `packages/core`:

```sh
bun run vendor:update:images
```

The script requires `curl`, `git`, `tar`, and either `sha256sum` or `shasum`. It downloads the exact pins declared at the top of `update.sh`, verifies upstream SHA-256 hashes, applies the committed stb patches, and copies the libwebp subset listed in `libwebp/FILES`.

To update a dependency:

1. Change its pin and matching hashes in `update.sh`; stb updates must also refresh the patch and `*_PATCHED_SHA256`.
2. Update the matching vendor README.
3. Refresh an stb patch if it no longer applies, or update `libwebp/FILES` if the required source closure changed.
4. Run `bun run vendor:update:images` and review the diff.
5. Run `bun run test:native` and `bun run build:native`.

Do not edit vendored stb headers directly. Keep OpenTUI changes in `stb/patches` so a clean upstream file plus the patches always reproduces the checked-in result.
