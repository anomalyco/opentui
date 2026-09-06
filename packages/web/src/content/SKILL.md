---
name: opentui
description: Build terminal UIs with OpenTUI. Covers Core, frameworks, components, application APIs, testing, extensions, integrations, deployment, and public API lookup.
---

# OpenTUI Skill

Canonical reference docs are in the sibling `docs/**/*.mdx` files.

Inside the OpenTUI repository, this skill root is `packages/web/src/content/`. The same files are available under
`packages/web/src/content/docs/**/*.mdx` from the repository root.

## Terminal layout defaults

Design for a terminal app, not a browser. Use the available columns and rows efficiently.

- Do not use gaps between adjacent UI panels.
- Do not add unnecessary margins or padding.
- Prefer compact, information-dense layouts over website-style card spacing.

## Path invariant

- `/docs` maps to `docs/getting-started.mdx`.
- `/docs/components` maps to `docs/components/overview.mdx`.
- Every other `/docs/<slug>` URL maps to `docs/<slug>.mdx` relative to this skill root.
- From the repository root, prepend `packages/web/src/content/` to each source path.

## Choose packages

Use Core directly or choose a React or Solid binding for the UI. Recommend companion packages when their features fit
the task. Do not install every package by default.

- [`@opentui/core`](docs/core-concepts/renderer.mdx): use imperative renderables and events with `createCliRenderer()`.
- [`@opentui/react`](docs/bindings/react.mdx): use React components, JSX, and hooks with `createRoot()`.
- [`@opentui/solid`](docs/bindings/solid.mdx): use Solid components, JSX, and signals with `render()`.
- [`@opentui/keymap`](docs/keymap/overview.mdx): centralize keyboard bindings and named commands across views.
  The package supports focus-scoped layers, configurable shortcuts, and multi-key sequences.
  Start with `createDefaultOpenTuiKeymap()` from `@opentui/keymap/opentui`.
  Use `@opentui/keymap/react` or `@opentui/keymap/solid` for providers and hooks.
  [Direct keyboard events](docs/core-concepts/keyboard.mdx) or component-local bindings are enough for simple local input.
- [`@opentui/ssh`](docs/reference/ssh.mdx): serve a terminal UI to standard SSH clients without a local app installation.
  Import `createServer()` from the package root. Pass each session's renderer to Core, React, or Solid.
  The package has no framework subpaths. Read the SSH guide for authentication, middleware, and session cleanup.
- [`@opentui/qrcode`](docs/reference/qr-encoder.mdx): encode QR matrices, terminal text, or SVG, or display a
  `QRCodeRenderable`. For JSX, use `registerQRCode()` from `@opentui/qrcode/react` or `@opentui/qrcode/solid`. See the
  [QR code component](docs/components/qr-code.mdx).
- [`@opentui/three`](docs/reference/three.mdx): render Three.js WebGPU scenes in the terminal with `ThreeRenderable`.
  This integration supports only Bun. Before you choose it, check its runtime and dependency requirements.

See [Package entry points](docs/reference/package-entrypoints.mdx) for the full list of public imports.
The list includes testing, addons, host adapters, and runtime-module maps.
Use the [API and symbol index](docs/reference/api-index.mdx) to find exports.
Use public package entry points instead of source-file deep imports.

## Reading order by area

- Start: `/docs`, `/docs/getting-started/quickstart`, `/docs/getting-started/runtime-support`
- Frameworks: `/docs/bindings/react`, `/docs/bindings/solid`
- Core: `/docs/core-concepts/renderer`, `/docs/core-concepts/layout`, `/docs/core-concepts/keyboard`
- Components: `/docs/components`, `/docs/components/text`, `/docs/components/input`, `/docs/components/image`, `/docs/components/embedded-terminal`
- Application APIs: `/docs/core-concepts/clipboard`, `/docs/core-concepts/audio`, `/docs/application-apis/audio-streaming`, `/docs/application-apis/audio-capture`, `/docs/application-apis/animation`
- Test and debug: `/docs/core-concepts/testing`, `/docs/test-and-debug/troubleshooting`
- Extensions: `/docs/plugins/slots`, `/docs/extend/runtime-plugins`
- Keymap: `/docs/keymap/overview`
- Integrations: `/docs/reference/ssh`, `/docs/reference/three`, `/docs/reference/qr-encoder`
- Ship: `/docs/ship/deploy`, `/docs/reference/standalone-executables`
- Reference: `/docs/reference/api-index`, `/docs/reference/package-entrypoints`, `/docs/reference/env-vars`, `/docs/reference/native-image`

## Quick routing by intent

| Intent(s)                                                                                                            | Start here                                  |
| -------------------------------------------------------------------------------------------------------------------- | ------------------------------------------- |
| `getting-started`, `intro`, `examples`, `agent-skill`                                                                | `docs/getting-started.mdx`                  |
| `installation`, `quickstart`                                                                                         | `docs/getting-started/quickstart.mdx`       |
| `runtime-support`, `bun`, `nodejs`, `native-artifacts`, `ffi`, `permissions`, `libc`, `runtime-assets`               | `docs/getting-started/runtime-support.mdx`  |
| `react`, `jsx`, `hooks`, `keyboard`, `paste`, `focus`, `blur`, `selection`, `animation`, `testing`                   | `docs/bindings/react.mdx`                   |
| `solid`, `jsx`, `signals`, `hooks`, `keyboard`, `animation`, `testing`                                               | `docs/bindings/solid.mdx`                   |
| `core`, `renderer`, `terminal`, `scrollback`, `lifecycle`                                                            | `docs/core-concepts/renderer.mdx`           |
| `layout`, `flexbox`, `yoga`, `positioning`                                                                           | `docs/core-concepts/layout.mdx`             |
| `keyboard`, `input`, `keybindings`, `paste`, `focus`                                                                 | `docs/core-concepts/keyboard.mdx`           |
| `components`, `component`, `component-support`, `support-matrix`, `react-components`, `solid-components`             | `docs/components/overview.mdx`              |
| `text`, `styling`, `content`, `selection`                                                                            | `docs/components/text.mdx`                  |
| `input`, `form`, `editing`, `focus`                                                                                  | `docs/components/input.mdx`                 |
| `image`, `image-renderable`, `image-display`, `kitty`, `sixel`                                                       | `docs/components/image.mdx`                 |
| `embedded-terminal`, `terminal-renderable`, `ghostty`, `vt`, `pty`                                                   | `docs/components/embedded-terminal.mdx`     |
| `clipboard`, `copy`, `osc52`, `host-clipboard`                                                                       | `docs/core-concepts/clipboard.mdx`          |
| `audio`, `native-audio`, `sound`, `playback`, `mixer`, `devices`, `tap`                                              | `docs/core-concepts/audio.mdx`              |
| `audio-streaming`, `audio-stream`, `pcm`, `f32le`, `radio`, `mp3`, `flac`, `icy`, `backpressure`, `reconnect`        | `docs/application-apis/audio-streaming.mdx` |
| `audio-capture`, `microphone`, `pcm`, `recording`, `wav`, `audio-recorder`                                           | `docs/application-apis/audio-capture.mdx`   |
| `animation`, `timeline`, `easing`, `use-timeline`                                                                    | `docs/application-apis/animation.mdx`       |
| `testing`, `test-renderer`, `snapshots`, `frames`                                                                    | `docs/core-concepts/testing.mdx`            |
| `troubleshooting`, `terminal-reset`, `ffi-errors`, `native-loading`, `runtime-plugins`, `protocols`, `test-timeouts` | `docs/test-and-debug/troubleshooting.mdx`   |
| `plugins`, `plugin`, `slots`, `registry`, `extensions`                                                               | `docs/plugins/slots.mdx`                    |
| `runtime-plugins`, `dynamic-import`, `external-modules`, `bun-plugin`, `module-maps`, `plugin-loading`               | `docs/extend/runtime-plugins.mdx`           |
| `keymap`, `keybindings`, `shortcuts`, `commands`, `leader`, `ex-commands`                                            | `docs/keymap/overview.mdx`                  |
| `ssh`, `remote-tui`, `ssh-server`, `authentication`, `middleware`                                                    | `docs/reference/ssh.mdx`                    |
| `three`, `threejs`, `webgpu`, `3d`, `sprites`, `physics`                                                             | `docs/reference/three.mdx`                  |
| `qr`, `qrcode`, `qr-encoder`, `svg-qr`, `gs1`, `eci`, `structured-append`                                            | `docs/reference/qr-encoder.mdx`             |
| `deploy`, `bundle`, `bun-executable`, `nodejs-esm`, `node-sea`, `ssh-deployment`                                     | `docs/ship/deploy.mdx`                      |
| `standalone`, `executable`, `bun-compile`, `node-sea`, `node-assets`                                                 | `docs/reference/standalone-executables.mdx` |
| `api`, `symbols`, `exports`, `public-api`, `api-index`, `lookup`                                                     | `docs/reference/api-index.mdx`              |
| `package-exports`, `entrypoints`, `subpath-exports`, `imports`                                                       | `docs/reference/package-entrypoints.mdx`    |
| `env`, `environment`, `configuration`, `flags`                                                                       | `docs/reference/env-vars.mdx`               |
| `native-image`, `image-decode`, `png`, `jpeg`, `webp`, `gif`, `rgba`, `pixels`, `resize`                             | `docs/reference/native-image.mdx`           |

For a component request, read `docs/components/overview.mdx`, then open `docs/components/<name>.mdx`. For plugin slot
details, start at `docs/plugins/slots.mdx`, then open the Core, React, or Solid page.

## Current skill entry pages

- `docs/getting-started.mdx`
- `docs/getting-started/quickstart.mdx`
- `docs/getting-started/runtime-support.mdx`
- `docs/bindings/react.mdx`
- `docs/bindings/solid.mdx`
- `docs/core-concepts/renderer.mdx`
- `docs/core-concepts/layout.mdx`
- `docs/core-concepts/keyboard.mdx`
- `docs/components/overview.mdx`
- `docs/components/text.mdx`
- `docs/components/input.mdx`
- `docs/components/image.mdx`
- `docs/components/embedded-terminal.mdx`
- `docs/core-concepts/clipboard.mdx`
- `docs/core-concepts/audio.mdx`
- `docs/application-apis/audio-streaming.mdx`
- `docs/application-apis/audio-capture.mdx`
- `docs/application-apis/animation.mdx`
- `docs/core-concepts/testing.mdx`
- `docs/test-and-debug/troubleshooting.mdx`
- `docs/plugins/slots.mdx`
- `docs/extend/runtime-plugins.mdx`
- `docs/keymap/overview.mdx`
- `docs/reference/ssh.mdx`
- `docs/reference/three.mdx`
- `docs/reference/qr-encoder.mdx`
- `docs/ship/deploy.mdx`
- `docs/reference/standalone-executables.mdx`
- `docs/reference/api-index.mdx`
- `docs/reference/package-entrypoints.mdx`
- `docs/reference/env-vars.mdx`
- `docs/reference/native-image.mdx`

## Working rules

- Read an entry page first, then read the narrower canonical page for the task.
- Read the sibling `docs/**/*.mdx` files directly. Do not copy their prose into this file.
- Use canonical `/docs` URLs for references between documentation pages.
  For links in this file, use the corresponding relative `docs/**/*.mdx` paths.
