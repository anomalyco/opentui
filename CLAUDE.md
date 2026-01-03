# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

OpenTUI is a TypeScript library for building terminal user interfaces (TUIs), serving as the foundational framework for opencode and terminaldotshop projects. The project is structured as a monorepo with multiple packages.

## Essential Commands

```bash
# Development
bun install                           # Install dependencies
bun run build                        # Build all packages
cd packages/core && bun run src/examples/index.ts  # Run core examples

# Package-specific builds (from packages/core)
bun run build:dev                    # Debug build with Zig
bun run build:prod                   # Production build with Zig
bun run build                        # Full build (native + TypeScript)

# Testing
bun test                             # Run all tests
bun test <file>                      # Run specific test file

# Release workflow
bun run prepare-release <version>    # Prepare for release
bun run pre-publish                  # Pre-publish checks
bun run publish                      # Publish packages
```

## Architecture

### Package Structure
- **@opentui/core**: Core library with imperative API, renderables, animations, text styling, and input handling. Contains native Zig components for performance-critical operations.
- **@opentui/react**: React reconciler implementation with custom hooks (useKeyboard, useRenderer, useResize)
- **@opentui/solid**: SolidJS reconciler with JSX runtime and Babel transformation

### Key Technologies
- **Runtime**: Bun (>=1.2.0 required)
- **Language**: TypeScript with strict mode
- **Native**: Zig (0.14.0-0.14.1) for performance-critical components
- **Cross-platform**: Builds for darwin/linux/windows on x64/arm64

### Native Integration
The core package includes Zig components that compile to native libraries (.so, .dll, .dylib) for each platform. These handle performance-critical rendering operations and are automatically built during `bun run build`.

### 3D Capabilities
Core package exports 3D features through separate entry points:
- WebGPU integration
- Three.js support
- Physics engines (Rapier, Planck)

## Development Patterns

### Testing
Tests use Bun's built-in test framework. Import pattern:
```typescript
import { expect, describe, it, beforeEach, afterEach } from "bun:test"
```

### Code Style
- No semicolons (Prettier configured)
- 120 character line width
- Explicit TypeScript types for public APIs
- camelCase for variables/functions, PascalCase for classes/interfaces

### File Organization
- Group related functionality in directories
- Use index files for clean exports
- Examples in `/examples` directories within each package

## Important Notes

- Always use Bun (not npm/yarn) for package management
- Native builds require Zig 0.14.0-0.14.1 installed
- When modifying native code, rebuild with appropriate optimization level
- Cross-platform binaries are pre-built but can be regenerated with build commands