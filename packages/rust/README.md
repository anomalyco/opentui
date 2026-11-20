# OpenTUI for Rust

Build terminal UIs in Rust with [OpenTUI](https://github.com/anomalyco/opentui)'s
native renderer, without JavaScript. The guide is on the website:
[Rust](https://opentui.com/docs/bindings/rust).

This workspace has three crates:

- `crates/opentui` is the framework: widgets, an event loop, focus, keyboard
  and mouse input, timers, and a test harness that needs no terminal. Most apps
  depend only on this crate.
- `crates/opentui-ssh` serves an app over SSH, one app per session.
- `crates/opentui-sys` is the raw C API of the native library (`opentui.h`),
  generated from the header.

## Use the crates in an app

Add the crate from crates.io with `cargo add opentui` (published under that name
from the first release after 0.9.5), extract the
`opentui-native-v<version>-<platform>.zip` of the release with the same
version, and set `OPENTUI_LIB_DIR` to the extracted directory.
[Install, link, and ship](https://opentui.com/docs/bindings/rust/install)
covers the steps, platforms, features, static and shared linking, and the
license notices to ship.

## Build from this checkout

The crates link the native library that this checkout builds into
`packages/native/lib/<artifact directory>`. Cargo does not build it, so build
it first, then run Cargo:

```sh
bun install
bun run build   # at the repository root, or `bun run build:native` in packages/core
cargo test --manifest-path packages/rust/Cargo.toml
```

`OPENTUI_LIB_DIR` takes precedence over the checkout's build. Give it an
absolute path, because Cargo resolves a relative one from `crates/opentui-sys`.

## Run the examples

From `packages/rust`:

```sh
sh run.sh hello       # a centered card with a button and live event reports
sh run.sh showcase    # every widget: a form, a list, a live log, a file table with source, and styled text
sh run.sh effects     # color matrices, filters, and animated effects on a panel or the whole screen
sh run.sh tasks       # a task list you move through and toggle
sh run.sh native      # the native layer and host, without the framework
sh run.sh workbench   # a native-layer build queue with live progress and a debug pane
sh run.sh terminal    # your shell in a terminal widget, beside a notes field
sh run.sh split       # a prompt in a footer that writes its lines to the scrollback above
sh run.sh video       # a video player; `cargo run --example video -- file.mp4` plays your own file
sh run.sh chat        # an SSH chat server on 127.0.0.1:2222: run `ssh -p 2222 localhost` per participant
sh run.sh tasks static
```

## Test

From `packages/rust`:

```sh
sh test.sh           # format, clippy, tests, and lifecycle checks, with shared and static linking
sh test.sh shared
cargo test --locked --workspace --features opentui/tokio,opentui/tree-sitter
sh scripts/check-targets.sh   # clippy for the macOS, arm64 and musl Linux, and Arm Windows targets
```

On Windows, run `sh test.sh` from Git Bash. It runs one pass, which links
`opentui.dll`. `cargo test` works from any shell.

`sh test.sh` runs on x86_64 Linux, macOS, and x86_64 Windows. The other
targets (arm64 Linux, Linux with musl, and Windows on Arm) are only
compile-checked, by `scripts/check-targets.sh`. That script needs Zig and the
targets' standard libraries, which it adds with rustup (or uses `rust-src`
without rustup). It does not link or run anything.

After a change to `opentui.h`, run `bun run generate:abi` in `packages/core`,
then `sh test.sh shared`, and fix the crates in the same change.

## Publish

Every release publishes the crates `opentui-sys`, `opentui`, and
`opentui-ssh` to crates.io at the release's version, which `prepare-release`
sets: the `Crates Publish` job in `.github/workflows/release.yml` runs `cargo publish --locked
--workspace` against the release's Linux x64 library. It authenticates with
crates.io trusted publishing, so no token is stored; each crate's trusted
publisher names `anomalyco/opentui`, `release.yml`, and no environment. A rerun
skips the crates that crates.io already has at that version.

To check the crates locally, from `packages/rust` with a native library for the
host (`../native/lib/<target>` after `bun run build`, or an extracted release
archive):

```sh
export OPENTUI_LIB_DIR=/absolute/path/to/native/library
cargo publish --dry-run --locked --workspace
```

`--workspace` packages all three, builds each from its `.crate` against the
library, and uploads them in dependency order: `-sys`, then `opentui`, then
`opentui-ssh`. The `.crate` build is outside the checkout, so it needs
`OPENTUI_LIB_DIR`, and the header check proves the library matches.
