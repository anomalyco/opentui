# anomalyco-opentui

A terminal UI framework for Rust, built on [OpenTUI](https://opentui.com)'s
native renderer, without JavaScript: widgets, an event loop, focus, keyboard
and mouse input, timers, and a test harness that needs no terminal.

This is OpenTUI's official Rust crate. It is published as `anomalyco-opentui`
until it can take the name `opentui`. Its library is named `opentui`, so add it
under that name and write `use opentui::...`:

```sh
cargo add anomalyco-opentui --rename opentui
```

The crate links OpenTUI's native library but does not build it. Download
`opentui-native-v<version>-<platform>.zip` from the
[GitHub release](https://github.com/anomalyco/opentui/releases) with the same
version as the crate, extract it into a directory of its own, and set
`OPENTUI_LIB_DIR` to that directory's absolute path.
[Install, link, and ship](https://opentui.com/docs/bindings/rust/install)
covers the platforms, features, static and shared linking, and the license
notices to ship. The guide is [Rust](https://opentui.com/docs/bindings/rust).

The crate is MIT-licensed. The native library includes FFmpeg, licensed under
LGPL-2.1-or-later; see
[`anomalyco-opentui-sys`](https://crates.io/crates/anomalyco-opentui-sys).
