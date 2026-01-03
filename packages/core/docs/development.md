# Development Guide

## Prerequisites

- [Bun](https://bun.sh) - JavaScript runtime and package manager
- [Zig](https://ziglang.org/learn/getting-started/) - Required for building native modules

### macOS

Building native modules on macOS requires Xcode (not just Command Line Tools) because the ghostty dependency builds an XCFramework that needs the iOS SDK.

1. Install Xcode from the Mac App Store
2. Set the developer directory:
   ```bash
   sudo xcode-select -s /Applications/Xcode.app/Contents/Developer
   ```

## Setup

```bash
git clone https://github.com/sst/opentui.git
cd opentui
bun install
```

## Building

```bash
bun run build
```

**Note:** Only needed when changing native Zig code. TypeScript changes don't require rebuilding.

## Running Examples

```bash
cd packages/core
bun run src/examples/index.ts
```

## Testing

```bash
# TypeScript tests
cd packages/core
bun test

# Native tests
bun run test:native

# Filter native tests
bun run test:native -Dtest-filter="test name"

# Benchmarks
bun run bench:native
```

## Local Development Linking

Link your local OpenTUI to another project:

```bash
./scripts/link-opentui-dev.sh /path/to/your/project
```

**Options:**

- `--react` - Also link `@opentui/react` and React dependencies
- `--solid` - Also link `@opentui/solid` and SolidJS dependencies
- `--dist` - Link built `dist` directories instead of source
- `--copy` - Copy instead of symlink (requires `--dist`)
- `--subdeps` - Find and link packages that depend on opentui (e.g., `opentui-spinner`)

**Examples:**

```bash
# Link core only
./scripts/link-opentui-dev.sh /path/to/your/project

# Link core and solid with subdependency discovery
./scripts/link-opentui-dev.sh /path/to/your/project --solid --subdeps

# Link built artifacts
./scripts/link-opentui-dev.sh /path/to/your/project --react --dist

# Copy for Docker/Windows
./scripts/link-opentui-dev.sh /path/to/your/project --dist --copy
```

The script automatically links:

- Main packages: `@opentui/core`, `@opentui/solid`, `@opentui/react`
- Peer dependencies: `yoga-layout`, `solid-js`, `react`, `react-dom`, `react-reconciler`
- Subdependencies (with `--subdeps`): Packages like `opentui-spinner` that depend on opentui

**Requirements:** Target project must have `node_modules` (run `bun install` first).

## Debugging

OpenTUI captures `console.log` output. Toggle the built-in console with backtick or use [Environment Variables](./env-vars.md) for debugging.
