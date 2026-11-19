# OpenTUI for Rust

A terminal UI framework for Rust built on
[OpenTUI](https://github.com/anomalyco/opentui)'s native renderer, without
JavaScript:

- `crates/opentui-sys` declares the whole C ABI (`opentui.h`), generated from
  the header.
- `crates/opentui` is the framework: widgets, an event loop, focus, mouse and
  keyboard input, timers, and tests that run without a terminal. Its lower
  layers wrap the ABI safely and run the terminal.
- `crates/opentui-ssh` serves apps over SSH, one app per session, as Core's
  `@opentui/ssh` does.

The guide is on the website: [Rust](https://opentui.com/docs/bindings/rust).

## Install

The crates are not on crates.io. Depend on them as a Cargo `git` dependency
pinned to a release tag, extract that release's
`opentui-native-v<version>-<platform>.zip`, and set `OPENTUI_LIB_DIR` to the
extracted directory. [Install, link, and
ship](https://opentui.com/docs/bindings/rust/install) covers platforms,
features, static and shared linking, and the licence notices to ship.

## Build

In this checkout, the crates link the native library of the checkout,
`packages/native/lib/<artifact directory>`. They do not build it. Build it
first, then run Cargo:

```sh
bun install
bun run build   # at the repository root, or `bun run build:native` in packages/core
cargo test --manifest-path packages/rust/Cargo.toml
```

`OPENTUI_LIB_DIR` wins over the checkout's build. Give an absolute path:
Cargo reads a relative one from `crates/opentui-sys`.

## Run the examples

```sh
sh run.sh hello       # a centered card with a button and live event reports
sh run.sh showcase    # every widget: a form, a list, a live log, a file table with source, and styled text
sh run.sh effects     # Core's color matrices, filters, and animated effects on a panel or the whole screen
sh run.sh tasks       # a task list you move through and toggle
sh run.sh native      # the native layer and host, without the framework
sh run.sh workbench   # a native-layer build queue with live progress and a debug pane
sh run.sh terminal    # your shell in a terminal widget, beside a notes field
sh run.sh split       # a prompt in a footer that writes its lines to the scrollback above
sh run.sh video       # a video player; `cargo run --example video -- file.mp4` plays your own file
sh run.sh chat        # an SSH chat server on 127.0.0.1:2222: run `ssh -p 2222 localhost` per participant
sh run.sh tasks static
cargo run --release --example bench   # headless frame timings
```

`crates/opentui/docs/markdown.md` records how the `Markdown` widget matches
Core's and where it differs on purpose.

## Test

```sh
sh test.sh           # format, clippy, tests, and lifecycle checks, with shared and static linking
sh test.sh shared
cargo test --locked --workspace --features opentui/tokio,opentui/tree-sitter
sh scripts/check-targets.sh   # clippy for the macOS, arm64 and musl Linux, and Arm Windows targets
```

On Windows, run `sh test.sh` from Git Bash; it runs one pass, which links
`opentui.dll`.
`cargo test` also works from any shell.

After a change to `opentui.h`, run `bun run generate:abi` in `packages/core`,
then `sh test.sh shared`, and fix the crates in the same change.

`scripts/check-targets.sh` keeps the code of the other targets compiling
while you work on one. It needs Zig and the targets' standard libraries, which
it adds with rustup, or `rust-src` without rustup; its header says how it uses
them. It does not link or run anything. `sh test.sh` runs on x86_64 Linux,
macOS, and x86_64 Windows; arm64 Linux, Linux with musl, and Windows on Arm
are only compile-checked.

CI runs `test.sh` on Linux, Windows and macOS for each pull request that
changes the crates, native code or the ABI generator, and `check-targets.sh` on
Linux. `rust-toolchain.toml` pins the toolchain it uses.

Widget tests in `crates/opentui/tests/` drive headless apps and compare
rendered frames. Native tests drive real Sessions into memory with a virtual
clock. `tests/lifecycle.rs` runs the `lifecycle` example on a pseudo-terminal
(ConPTY on Windows), both on a hand-written host loop and on `App::run`, and
checks that quitting, resizing, returned errors, panics, and captured stderr
each leave the alternate screen; on Windows it also checks that the console
modes are restored. On Unix, `scripts/pty-smoke.py` adds signals and Ctrl-Z,
and checks that each exit path restores the terminal settings.
`crates/opentui/tests/remote.rs` plays the transport for apps on remote
terminals, and `crates/opentui-ssh/tests/server.rs` connects to a real server
with russh's client; one of its tests runs OpenSSH's `ssh` on a
pseudo-terminal, and is skipped where `ssh` is missing.
