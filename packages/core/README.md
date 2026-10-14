<!-- Keep the project introduction aligned with the repository README and opentui.com. -->

<p align="center">
  <a href="https://opentui.com">
    <img alt="OpenTUI logo" src="https://opentui.com/opentui-logo-auto.svg" width="270" />
  </a>
</p>

<div align="center">
    <a href="https://www.npmjs.com/package/@opentui/core"><img alt="npm version" src="https://img.shields.io/npm/v/@opentui/core?style=flat-square" /></a>
    <a href="https://github.com/anomalyco/opentui/actions/workflows/build-core.yml"><img alt="Core build status" src="https://img.shields.io/github/actions/workflow/status/anomalyco/opentui/build-core.yml?style=flat-square&branch=main" /></a>
</div>

OpenTUI is a library to build terminal user interfaces.

- It is written in Zig.
- You write TypeScript directly or through React and Solid.
- You arrange boxes and text with flexbox.
- You add selects, inputs, and scroll boxes with keyboard and mouse controls.
- You can play sounds, show images, and render 3D graphics.

OpenCode uses OpenTUI in production for millions of users.

[Website](https://opentui.com) | [Documentation](https://opentui.com/docs) | [Packages](https://opentui.com/packages)

## OpenTUI Core

`@opentui/core` supplies the renderer and TypeScript API. You use imperative renderables and events directly. The
TypeScript packages call native Zig through an internal foreign function interface (FFI) boundary.

```typescript
import { TextRenderable, createCliRenderer } from "@opentui/core"

const renderer = await createCliRenderer({ exitOnCtrlC: true })

renderer.root.add(new TextRenderable(renderer, { content: "Hello, OpenTUI!" }))
```

`exitOnCtrlC: true` calls `renderer.destroy()` when the user presses Ctrl+C. The code that creates the renderer must
call `renderer.destroy()` on every other shutdown path.

Install the package:

```bash
bun add @opentui/core
```

Then build your first app with the [quickstart](https://opentui.com/docs/getting-started/quickstart).

## Runtime and platform support

`@opentui/core` runs on Bun 1.3.0 or later, or on Node.js 26.4.0 or later with ECMAScript modules (ESM) and
`--experimental-ffi`.

Use Bun 1.4.0 or later on native Windows arm64.

The native ABI and the generated platform packages, such as `@opentui/core-linux-x64`, are internal distribution
surfaces, not application APIs.

### Experimental FreeBSD builds

FreeBSD targets are `freebsd-x64` (amd64) and `freebsd-arm64` (aarch64). Use native Node.js 26.4.0 or later with
`--experimental-ffi` at runtime; a Linux Bun process running under Linuxulator is not a native FreeBSD runtime.

Build the native library with FreeBSD Zig 0.16.0. From `packages/native`:

```sh
sh scripts/prepare-zig-deps.sh
zig build -Doptimize=ReleaseFast
zig build test
```

Package the result from `packages/core`. Bun can run the packaging tools under Linuxulator; select the FreeBSD target
explicitly so its reported Linux platform does not select a Linux package:

```sh
bun scripts/build.ts --native --skip-zig --target=freebsd-x64
bun run build:lib
```

Use `--target=freebsd-arm64` on an arm64 host. The generated native package is staged in
`packages/core/node_modules/@opentui/core-freebsd-<arch>` alongside the JavaScript distribution in `packages/core/dist`.
Install both packages together in the consuming application; FreeBSD native packages are not yet available from npm.

For the full repository build under Linuxulator, run from the repository root with native FreeBSD Zig on `PATH`:

```sh
OPENTUI_NATIVE_TARGET=freebsd-x64 bun run build
```

`OPENTUI_NATIVE_TARGET` selects the packaging target for the root build's `--skip-zig` step; a CLI `--target` takes
precedence. Do not use this variable to disguise a Linux library as a FreeBSD library.

For a cross-build, select `-Dlibrary-target=x86_64-freebsd` or `-Dlibrary-target=aarch64-freebsd`. Zig 0.16.0 supplies
FreeBSD headers and libc link stubs. Package that artifact with the matching `--target` and `--skip-zig`. Cross-compiling
a library does not verify that it runs on the target system.

Native desktop clipboard backends are not enabled for FreeBSD yet. Node FFI runtime validation is required before
treating this experimental port as production support.

## AI agent skill

Install the OpenTUI documentation as a skill for your AI coding assistant with [`npx skills`](https://skills.sh):

```bash
npx skills add anomalyco/opentui --skill opentui
```

Add `-g` to install the skill globally.

## License

OpenTUI is licensed under the [MIT License](https://github.com/anomalyco/opentui/blob/main/LICENSE).
