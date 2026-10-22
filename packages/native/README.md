# Native API

OpenTUI uses Context-owned scenes and Sessions for production rendering, including
text, editors, custom paint hooks, images, detached surfaces, and split output.
Standalone resources use the same checked ownership model without a terminal.

Read [Resources and ownership](https://opentui.com/docs/native/resources) for
resource bindings, text copy units, and scoped framebuffer access.
[Frames and output](https://opentui.com/docs/native/frames) defines mutation
admission, painted drafts, and transport completion.
[How Core uses native](https://opentui.com/docs/native/core) explains TypeScript
staging and resource ownership.
[Host I/O and time](https://opentui.com/docs/native/host-io-time) defines Context
file operations, Session deadlines, and native diagnostic clocks.

## API surfaces

- [`src/opentui.zig`](src/opentui.zig) is the public Zig module. It exports the
  checked `Context` API and raw Zig primitives, including `CliRenderer`,
  `NativeRenderable`, `OptimizedBuffer`, text buffers, and pools. Callers manage
  the lifetimes of raw primitives. Importing a raw primitive does not add Context
  checks to it.
- [`include/opentui.h`](include/opentui.h) defines the checked `ot_*` C ABI for
  Contexts, Sessions, scenes, drawing, text, editors, styles, leases, clipboard,
  and diagnostics.
  The ABI is experimental and at version 1. Core renders through it.
- [`../core/src/zig.ts`](../core/src/zig.ts) supplies TypeScript wrappers over that
  checked ABI. Its checked signatures, callbacks, constants, and record layouts come
  from [`native-abi.generated.ts`](../core/src/native-abi.generated.ts).

## ABI generation and builds

Use C headers and libraries from the same revision. Set each versioned record's
exact `struct_size` and `abi_version`, and leave unused flags and reserved fields
zero. Follow the output and failure contract of each operation in the header.

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
Do not edit generated bindings. `check:abi` detects stale output. Use
`bun run check:abi --all-targets` to also compare the layouts of all supported targets.
An unsupported record shape or calling convention fails the script. It does not
produce partial metadata. C compiler assertions also check complete function and
callback prototypes, record layouts, field types, and constant values. Translate-C
alone is not enough, because it can drop callback calling-convention attributes and
ignore `#pragma pack`.

From `packages/native`, `bun run build` installs the header and libraries under
`lib/<target>/` for the host target. Linux and macOS produce `libopentui.a` beside
the shared library. Windows produces `opentui-static.lib`, `opentui.lib` for DLL
imports, and `opentui.dll`. Static linkage also needs the platform and C++ runtime
libraries. `zig build -Dall` builds all supported targets.
`zig build -Dlibrary-target=<target>` builds one target.

```sh
zig build test-abi --summary all
```

This command runs the C fixture against the static and shared libraries on the host.
On a glibc Linux host, the fixture targets glibc 2.17. `check:abi --all-targets`
checks layouts for all eight supported targets. It does not test macOS or Windows
runtime linkage or terminal behavior.

The external [`examples/hello`](examples/hello) package imports the public Zig module
without JavaScript.
