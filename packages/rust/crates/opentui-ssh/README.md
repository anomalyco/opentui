# opentui-ssh

Serve [OpenTUI](https://opentui.com) apps over SSH, one app per session. Each
session runs its app on a thread of its own, with input, output, and window
size from the SSH channel.

```sh
cargo add opentui-ssh
cargo add anomalyco-opentui --rename opentui
```

`anomalyco-opentui` is OpenTUI's official Rust crate, published under an
interim name; its library is named `opentui`. Like it, this crate needs
OpenTUI's native library: see
[Install, link, and ship](https://opentui.com/docs/bindings/rust/install). The
guide is [Serve over SSH](https://opentui.com/docs/bindings/rust/ssh).

MIT-licensed.
