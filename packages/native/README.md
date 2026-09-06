# Native API

OpenTUI uses Context-owned scenes and Sessions for production rendering, including
text, editors, custom paint hooks, images, detached surfaces, and split output.
Standalone resources use the same checked ownership model without a terminal.

## API surfaces

- [`src/opentui.zig`](src/opentui.zig) exports the checked `Context` API and explicit
  raw Zig primitives, including `CliRenderer`, `NativeRenderable`, `OptimizedBuffer`,
  text buffers, and pools. Raw primitives remain a separate capability: callers
  manage their lifetimes and do not acquire Context guards merely by importing them.
- [`include/opentui.h`](include/opentui.h) defines the checked `ot_*` C ABI for
  Contexts, Sessions, scenes, drawing, text, editors, styles, leases, and diagnostics.
  It remains version 1 and experimental as an ABI, not an unused rendering backend.
- [`../core/src/zig.ts`](../core/src/zig.ts) supplies TypeScript wrappers over that
  checked ABI. Its checked signatures, callbacks, constants, and record layouts come
  from [`native-abi.generated.ts`](../core/src/native-abi.generated.ts).

## ABI generation and builds

Use matching C headers and libraries. Initialize each versioned record's exact
`struct_size` and `abi_version`, and leave unused flags and reserved fields zero.
Follow the header's per-operation output and failure contracts.

From `packages/core`:

```sh
bun run generate:abi
bun run check:abi
bun run test:abi
```

[`scripts/native-abi.ts`](../core/scripts/native-abi.ts) uses Zig Translate-C and
[`scripts/native-abi.zig`](../core/scripts/native-abi.zig) reflection to derive scalar
widths, signatures, callback types, constants, record sizes, alignment, and field
offsets from the header. Pointer nullability, retention, address fields, and portable
`buffer`/`ptr` policy live in
[`scripts/native-abi-pointers.ts`](../core/scripts/native-abi-pointers.ts), because C
types cannot prove lifetimes. Review that metadata when ownership contracts change.
Do not edit generated bindings. `check:abi` detects stale output; use
`bun run check:abi --all-targets` to compare supported target layouts too.
Unsupported record shapes and calling conventions reject instead of producing
partial metadata. C compiler type assertions also verify complete function and
callback prototypes, because Translate-C can discard callback calling-convention
attributes.

From `packages/native`, `bun run build` installs headers and libraries under
`lib/<target>/`. Linux and macOS produce `libopentui.a` beside the shared library.
Windows produces `opentui-static.lib`, `opentui.lib` for DLL imports, and `opentui.dll`.
Static linkage still requires the relevant platform and C++ runtime libraries.
`zig build -Dall` builds all supported targets; `-Dlibrary-target=<target>` selects one.

```sh
zig build test-abi --summary all
```

This checks C/Zig layouts for all eight supported targets and runs the C fixture with
static and dynamic linking on the host. Linux acceptance targets glibc 2.17.
`zig build test-abi-layout --summary all` runs only layout checks. Cross-target layout
checks do not establish macOS/Windows runtime linkage or terminal behavior.

The external [`examples/hello`](examples/hello) package imports the public Zig module
without JavaScript.

The [`examples/rust`](examples/rust) Cargo crate provides Rust bindings to the checked
C ABI with thread-affine Context, Session, and Node owners. It is an example.
The crate links existing native artifacts without JavaScript or a Zig implementation bridge.
