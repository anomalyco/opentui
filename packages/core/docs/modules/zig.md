# Zig Native Module

The Zig module provides high-performance native acceleration for OpenTUI through Foreign Function Interface (FFI) bindings, enabling fast terminal rendering and buffer operations.

## Overview

OpenTUI uses Zig-compiled native libraries for performance-critical operations. The module automatically loads platform-specific binaries and provides TypeScript interfaces to native functions.

## Architecture

### Platform Support

Native binaries are provided for:
- **Darwin (macOS)**: x64, arm64
- **Linux**: x64, arm64
- **Windows**: x64, arm64

```typescript
// Automatic platform detection
const module = await import(`@opentui/core-${process.platform}-${process.arch}/index.ts`)
const targetLibPath = module.default

// Verify platform support
if (!existsSync(targetLibPath)) {
  throw new Error(`opentui is not supported on: ${process.platform}-${process.arch}`)
}
```

### FFI Library Loading

The module uses Bun's FFI to load native functions:

```typescript
import { dlopen } from "bun:ffi"

const lib = dlopen(libPath, {
  createRenderer: {
    args: ["u32", "u32"],  // width, height
    returns: "ptr"          // renderer pointer
  },
  // ... more functions
})
```

## Core Functions

### Renderer Management

Create and manage native renderers:

```typescript
// Create renderer
createRenderer(width: number, height: number): Pointer | null

// Destroy renderer
destroyRenderer(
  renderer: Pointer, 
  useAlternateScreen: boolean, 
  splitHeight: number
): void

// Configure threading
setUseThread(renderer: Pointer, useThread: boolean): void

// Set background color
setBackgroundColor(renderer: Pointer, color: RGBA): void

// Update render offset
setRenderOffset(renderer: Pointer, offset: number): void

// Perform render
render(renderer: Pointer, force: boolean): void
```

### Buffer Operations

Native buffer creation and manipulation:

```typescript
// Create optimized buffer
createOptimizedBuffer(
  width: number, 
  height: number, 
  respectAlpha?: boolean
): OptimizedBuffer

// Destroy buffer
destroyOptimizedBuffer(bufferPtr: Pointer): void

// Get buffer dimensions
getBufferWidth(buffer: Pointer): number
getBufferHeight(buffer: Pointer): number

// Clear buffer
bufferClear(buffer: Pointer, color: RGBA): void

// Get buffer data pointers
bufferGetCharPtr(buffer: Pointer): Pointer      // Character array
bufferGetFgPtr(buffer: Pointer): Pointer        // Foreground colors
bufferGetBgPtr(buffer: Pointer): Pointer        // Background colors
bufferGetAttributesPtr(buffer: Pointer): Pointer // Text attributes
```

### Text Rendering

Accelerated text drawing:

```typescript
// Draw text to buffer
bufferDrawText(
  buffer: Pointer,
  text: string,
  x: number,
  y: number,
  color: RGBA,
  bgColor?: RGBA,
  attributes?: number
): void

// Set cell with alpha blending
bufferSetCellWithAlphaBlending(
  buffer: Pointer,
  x: number,
  y: number,
  char: string,
  color: RGBA,
  bgColor: RGBA,
  attributes?: number
): void
```

### Box Drawing

Native box rendering with borders:

```typescript
bufferDrawBox(
  buffer: Pointer,
  x: number,
  y: number,
  width: number,
  height: number,
  borderSides: number,    // Packed bitfield
  borderStyle: Pointer,   // Border character array
  fg: RGBA,
  bg: RGBA,
  title: string | null,
  titleAlignment: number  // 0=left, 1=center, 2=right
): void
```

### Frame Buffer Operations

Efficient buffer copying and blitting:

```typescript
// Draw frame buffer to target
drawFrameBuffer(
  targetBufferPtr: Pointer,
  destX: number,
  destY: number,
  bufferPtr: Pointer,
  sourceX?: number,
  sourceY?: number,
  sourceWidth?: number,
  sourceHeight?: number
): void

// Fill rectangle
bufferFillRect(
  buffer: Pointer,
  x: number,
  y: number,
  width: number,
  height: number,
  color: RGBA
): void
```

## TextBuffer Support

Native text buffer for efficient text management:

```typescript
// Create/destroy text buffer
createTextBuffer(capacity: number): Pointer
destroyTextBuffer(buffer: Pointer): void

// Get data pointers
textBufferGetCharPtr(buffer: Pointer): Pointer
textBufferGetFgPtr(buffer: Pointer): Pointer
textBufferGetBgPtr(buffer: Pointer): Pointer
textBufferGetAttributesPtr(buffer: Pointer): Pointer

// Buffer operations
textBufferGetLength(buffer: Pointer): number
textBufferGetCapacity(buffer: Pointer): number
textBufferResize(buffer: Pointer, newCapacity: number): void
textBufferReset(buffer: Pointer): void

// Set cell data
textBufferSetCell(
  buffer: Pointer,
  index: number,
  char: number,
  fg: RGBA,
  bg: RGBA,
  attributes: number
): void

// Concatenate buffers
textBufferConcat(buffer1: Pointer, buffer2: Pointer): Pointer

// Selection support
textBufferSetSelection(
  buffer: Pointer,
  start: number,
  end: number,
  selectionFg: RGBA,
  selectionBg: RGBA
): void
textBufferResetSelection(buffer: Pointer): void

// Write chunks efficiently
textBufferWriteChunk(
  buffer: Pointer,
  chars: Pointer,
  length: number,
  fg: RGBA,
  bg: RGBA,
  attributes: Pointer
): number

// Line information
textBufferFinalizeLineInfo(buffer: Pointer): void
textBufferGetLineStartsPtr(buffer: Pointer): Pointer
textBufferGetLineWidthsPtr(buffer: Pointer): Pointer
textBufferGetLineCount(buffer: Pointer): number

// Draw to buffer
bufferDrawTextBuffer(
  targetBuffer: Pointer,
  textBuffer: Pointer,
  x: number,
  y: number,
  scrollX: number,
  scrollY: number,
  viewWidth: number,
  viewHeight: number,
  wrap: boolean
): void
```

## Terminal Control

Native terminal manipulation:

```typescript
// Clear terminal screen
clearTerminal(renderer: Pointer): void

// Cursor control
setCursorPosition(x: number, y: number, visible: boolean): void
setCursorStyle(renderer: Pointer, style: CursorStyle, visible: boolean): void
setCursorColor(color: RGBA): void

// Mouse support
enableMouse(renderer: Pointer, enable: boolean): void
disableMouse(renderer: Pointer): void
```

## Hit Testing

Pixel-perfect hit detection:

```typescript
// Add hit region
addToHitGrid(
  renderer: Pointer,
  x: number,
  y: number,
  width: number,
  height: number,
  id: number
): void

// Check hit at position
checkHit(renderer: Pointer, x: number, y: number): number

// Debug hit grid
dumpHitGrid(renderer: Pointer): void
```

## Performance Monitoring

Native performance statistics:

```typescript
// Update render stats
updateStats(
  renderer: Pointer,
  time: number,
  fps: number,
  frameCallbackTime: number
): void

// Update memory stats
updateMemoryStats(
  renderer: Pointer,
  heapUsed: number,
  heapTotal: number,
  arrayBuffers: number
): void
```

## Debug Features

Development and debugging tools:

```typescript
// Debug overlay
setDebugOverlay(
  renderer: Pointer,
  enabled: boolean,
  corner: DebugOverlayCorner
): void

// Dump buffers for debugging
dumpBuffers(renderer: Pointer, timestamp: bigint): void
dumpStdoutBuffer(renderer: Pointer, timestamp: bigint): void
```

## RenderLib Interface

TypeScript interface wrapping native functions:

```typescript
export interface RenderLib {
  createRenderer: (width: number, height: number) => Pointer | null
  destroyRenderer: (renderer: Pointer, useAlternateScreen: boolean, splitHeight: number) => void
  setUseThread: (renderer: Pointer, useThread: boolean) => void
  setBackgroundColor: (renderer: Pointer, color: RGBA) => void
  render: (renderer: Pointer, force: boolean) => void
  getNextBuffer: (renderer: Pointer) => OptimizedBuffer
  getCurrentBuffer: (renderer: Pointer) => OptimizedBuffer
  createOptimizedBuffer: (width: number, height: number, respectAlpha?: boolean) => OptimizedBuffer
  // ... and many more
}
```

## Usage Example

```typescript
import { resolveRenderLib } from '@opentui/core/zig'
import { RGBA } from '@opentui/core'

// Get native library
const lib = resolveRenderLib()

// Create renderer
const renderer = lib.createRenderer(80, 24)

// Create buffer
const buffer = lib.createOptimizedBuffer(80, 24, true)

// Draw text
lib.bufferDrawText(
  buffer.ptr,
  "Hello, Native!",
  10, 5,
  RGBA.fromValues(1, 1, 1, 1),
  RGBA.fromValues(0, 0, 0, 1),
  0
)

// Render
lib.render(renderer, false)

// Cleanup
lib.destroyOptimizedBuffer(buffer.ptr)
lib.destroyRenderer(renderer, false, 0)
```

## Building Native Libraries

To rebuild the native libraries:

```bash
# Development build (debug symbols)
bun run build:dev

# Production build (optimized)
bun run build:prod

# Build for all platforms
bun run build:all
```

Requirements:
- Zig 0.14.0-0.14.1
- Bun runtime

## Performance Benefits

Native acceleration provides:
- **10-100x faster** buffer operations vs pure JavaScript
- **Minimal GC pressure** through direct memory management
- **SIMD optimizations** where available
- **Efficient text rendering** with native string handling
- **Zero-copy operations** for buffer transfers

## API Reference

### Exported Functions

- `getOpenTUILib(libPath?: string)` - Load FFI library
- `resolveRenderLib()` - Get singleton RenderLib instance

### Types

- `RenderLib` - TypeScript interface for native functions
- `Pointer` - Native memory pointer type from Bun FFI

## Related Modules

- [Buffer](./buffer.md) - OptimizedBuffer that uses native acceleration
- [Text Buffer](./text-buffer.md) - TextBuffer with native support
- [Rendering](./rendering.md) - Renderer using native functions