# Development Guide

## Prerequisites

- [Bun](https://bun.sh) - JavaScript runtime and package manager
- [Zig](https://ziglang.org/learn/getting-started/) - Required for building native modules

## Setup

```bash
git clone https://github.com/anomalyco/opentui.git
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
cd packages/examples
bun run dev
```

## Testing

```bash
# Build native dependencies first
bun run build

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
- Peer dependencies: `solid-js`, `react`, `react-dom`, `react-reconciler`
- Subdependencies (with `--subdeps`): Packages like `opentui-spinner` that depend on opentui

**Requirements:** Target project must have `node_modules` (run `bun install` first).

## Debugging

OpenTUI captures `console.log` output. Toggle the built-in console with backtick or use [Environment Variables](./env-vars.md) for debugging.

## Terminal Compatibility

### OSC 66 Artifacts on Older Terminals

**Problem:** If you see weird artifacts containing "66" in your terminal when running OpenTUI applications, your terminal emulator doesn't support OSC 66 escape sequences (used for explicit character width detection).

**Affected Terminals:**

- GNOME Terminal
- Konsole (older versions)
- xterm (older versions)
- Many VT100/VT220 emulators

**Solution:** Disable OSC 66 queries by setting an environment variable:

```bash
export OPENTUI_FORCE_EXPLICIT_WIDTH=false
```

Or run your application with:

```bash
OPENTUI_FORCE_EXPLICIT_WIDTH=false your-app
```

**For Application Developers:**

Set it in your code before creating the renderer:

```typescript
process.env.OPENTUI_FORCE_EXPLICIT_WIDTH = "false"

const renderer = new CliRenderer()
// ... rest of your app
```

Or add to your `.env` file:

```bash
OPENTUI_FORCE_EXPLICIT_WIDTH=false
```

**What This Does:**

- Prevents OSC 66 detection queries from being sent
- Disables the explicit width feature
- Falls back to standard width calculation
- No visual artifacts on unsupported terminals

**Modern Terminals:** If your terminal supports OSC 66 (Kitty, Ghostty, WezTerm, Alacritty, iTerm2), you don't need this setting - they work correctly by default.
