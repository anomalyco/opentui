# opentui

A terminal UI framework for Rust, built on [OpenTUI](https://opentui.com)'s
native renderer, without JavaScript: widgets, an event loop, focus, keyboard
and mouse input, timers, and a test harness that needs no terminal.

```sh
cargo add opentui
```

The crate is published as `opentui` from the first release after 0.9.5;
versions 0.9.4 and 0.9.5 were published as `anomalyco-opentui`.

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
[`opentui-sys`](https://crates.io/crates/opentui-sys).
