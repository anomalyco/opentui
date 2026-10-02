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

## Packages

- [`@opentui/core`](packages/core) - Native terminal UI library with TypeScript bindings.
- [`@opentui/react`](packages/react) - React renderer for building terminal user interfaces with OpenTUI Core.
- [`@opentui/solid`](packages/solid) - Solid renderer for building terminal user interfaces with OpenTUI Core.
- [`@opentui/keymap`](packages/keymap) - Key binding and command routing library for terminal and browser applications.
- [`@opentui/qrcode`](packages/qrcode) - QR code encoder and renderable with React and Solid surfaces.
- [`@opentui/three`](packages/three) - Three.js WebGPU renderer for OpenTUI.
- [`@opentui/ssh`](packages/ssh) - SSH server integration for OpenTUI applications.

**Private packages**

- [`@opentui/native`](packages/native) - Private workspace with the Zig implementation, native tests, and benchmarks.
- [`@opentui/examples`](packages/examples) - Private workspace with example applications and a standalone examples executable.
- [`@opentui/web`](packages/web) - Private workspace with the documentation website and the AI agent skill.

## AI agent skill

Install the OpenTUI documentation as a skill for your AI coding assistant with [`npx skills`](https://skills.sh):

```bash
npx skills add anomalyco/opentui --skill opentui
```

Add `-g` to install the skill globally.

## Development

Development requires Bun 1.4.1 or later and Zig 0.16.0.

See [AGENTS.md](AGENTS.md) for engineering, tooling, and verification conventions.

```bash
bun install
```

Run package scripts from their package directory. Run `bun run build` from the repository root after you change
native code or cross-package build outputs. Ordinary TypeScript changes do not require a root build.

Run repository tests and static checks from the repository root:

```bash
bun run test
bun run fmt:check
bun run lint
```

To link the source packages into a Bun-managed project, install that project's dependencies, then run
`./scripts/link-opentui-dev.sh /path/to/project` from the repository root. Add `--react` or `--solid` when needed.

## Contributing

OpenTUI is open for contributions.

## License

OpenTUI is licensed under the [MIT License](LICENSE).
