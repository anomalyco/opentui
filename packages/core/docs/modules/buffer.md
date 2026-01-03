# Buffer Module

The buffer module provides the high-performance `OptimizedBuffer` class, which serves as the core data structure for terminal rendering operations with native Zig acceleration.

## Overview

`OptimizedBuffer` manages terminal display data using typed arrays for optimal performance. It integrates with native Zig code via FFI for accelerated operations while providing JavaScript fallbacks.

## Core Architecture

### Buffer Structure

The buffer uses separate typed arrays for different data types:

```typescript
{
  char: Uint32Array,      // Unicode character codes
  fg: Float32Array,       // Foreground RGBA (0.0-1.0)
  bg: Float32Array,       // Background RGBA (0.0-1.0)
  attributes: Uint8Array  // Text attributes (bold, italic, etc.)
}
```

### Creating Buffers

```typescript
import { OptimizedBuffer } from '@opentui/core'

// Create a buffer
const buffer = OptimizedBuffer.create(80, 24, {
  respectAlpha: true  // Enable alpha blending
})

// Access dimensions
const width = buffer.getWidth()   // 80
const height = buffer.getHeight()  // 24
```

## Cell Operations

### Basic Cell Manipulation

```typescript
import { RGBA } from '@opentui/core'

const fg = RGBA.fromValues(1.0, 1.0, 1.0, 1.0)  // White
const bg = RGBA.fromValues(0.0, 0.0, 1.0, 1.0)  // Blue

// Set a cell
buffer.setCell(10, 5, 'A', fg, bg, 0)

// Get cell data
const cell = buffer.get(10, 5)
// Returns: { char: 65, fg: RGBA, bg: RGBA, attributes: 0 }
```

### Alpha Blending

Advanced alpha blending with perceptual adjustments:

```typescript
const semitransparent = RGBA.fromValues(1.0, 0.0, 0.0, 0.5)

// Automatically blends with existing content
buffer.setCellWithAlphaBlending(
  10, 5,
  'B',
  fg,
  semitransparent,
  0
)
```

Alpha blending features:
- Perceptual alpha curve for natural transparency
- Character preservation when overlaying spaces
- Automatic foreground/background blending

## Text Drawing

### Basic Text

```typescript
const text = "Hello, World!"
const x = 10, y = 5
const fg = RGBA.fromValues(1.0, 1.0, 1.0, 1.0)
const bg = RGBA.fromValues(0.0, 0.0, 0.0, 1.0)

buffer.drawText(text, x, y, fg, bg, 0)
```

### Text with Selection

Support for text selection highlighting:

```typescript
buffer.drawText(
  "Select this text",
  10, 5,
  fg, bg, 0,
  {
    start: 7,
    end: 11,
    bgColor: RGBA.fromValues(0.0, 0.0, 1.0, 1.0),
    fgColor: RGBA.fromValues(1.0, 1.0, 1.0, 1.0)
  }
)
```

## Box Drawing

### Basic Box

```typescript
buffer.drawBox(
  5, 2,      // x, y
  20, 10,    // width, height
  fg, bg,
  true,      // border
  true,      // fill
  'single'   // border style
)
```

### Advanced Box Options

```typescript
// Partial borders
buffer.drawBox(
  5, 2, 20, 10,
  fg, bg,
  ['top', 'bottom'],  // Only top and bottom borders
  true,
  'double'
)

// With title
buffer.drawBoxWithTitle(
  5, 2, 20, 10,
  fg, bg,
  true, true,
  'rounded',
  'My Box',     // title
  'center'      // alignment: 'left', 'center', 'right'
)
```

### Border Styles

Available border styles:
- `'single'` - `┌─┐│└┘`
- `'double'` - `╔═╗║╚╝`
- `'rounded'` - `╭─╮│╰╯`
- `'heavy'` - `┏━┓┃┗┛`

## Buffer Operations

### Clearing

```typescript
// Clear entire buffer
buffer.clear(
  RGBA.fromValues(0.0, 0.0, 0.0, 1.0),  // background
  ' '                                      // clear character
)

// Clear region
buffer.clearRect(10, 5, 20, 10, bg)
```

### Blitting

Copy regions between buffers:

```typescript
const source = OptimizedBuffer.create(20, 10)
const dest = OptimizedBuffer.create(80, 24)

// Basic blit
dest.blit(source, 10, 5)

// Blit with region
dest.blitRegion(
  source,
  0, 0, 10, 5,    // source region
  20, 10           // destination position
)

// Blit with alpha blending
dest.blitWithAlpha(source, 10, 5)
```

### Merging

Merge buffers with transparency:

```typescript
// Merge overlay onto base
base.merge(overlay, 10, 5)

// Partial merge
base.mergeRegion(
  overlay,
  5, 5, 15, 10,  // overlay region
  20, 10         // destination
)
```

## Performance Features

### Native FFI Acceleration

Most operations have optimized Zig implementations:

```typescript
// Toggle between FFI and JavaScript implementations
buffer.useFFI = false  // Use JavaScript fallback
buffer.clearLocal(bg, ' ')  // Explicit local implementation

buffer.useFFI = true   // Use native Zig (default)
buffer.clearFFI(bg)    // Explicit FFI implementation
```

### Direct Buffer Access

For custom processing:

```typescript
const buffers = buffer.buffers

// Direct manipulation
for (let i = 0; i < buffers.char.length; i++) {
  if (buffers.char[i] === 32) {  // space
    buffers.fg[i * 4] = 0.5      // dim foreground
  }
}
```

### Memory Management

Buffers are reference-counted in native code:

```typescript
// Buffers are automatically managed
const buffer = OptimizedBuffer.create(80, 24)
// Native memory allocated

// When buffer goes out of scope, 
// garbage collection handles cleanup
```

## Utility Functions

### Color Blending

Internal color blending with perceptual adjustments:

```typescript
// Perceptual alpha curve:
// - Values > 0.8: Subtle curve for near-opaque
// - Values ≤ 0.8: Power curve for smooth blending
```

### Drawing Options Packing

Border configuration is packed into bitfields for efficiency:

```typescript
// Internally packed as:
// bits 0-3: border sides (top/right/bottom/left)
// bit 4: fill flag
// bits 5-6: title alignment (0=left, 1=center, 2=right)
```

## Integration

### With Renderables

```typescript
class CustomRenderable extends Renderable {
  render(buffer: OptimizedBuffer) {
    buffer.drawText(
      this.content,
      this.x, this.y,
      this.fg, this.bg
    )
  }
}
```

### With TextBuffer

```typescript
// Convert TextBuffer to OptimizedBuffer
const textBuffer = new TextBuffer(80, 24)
const optimized = textBuffer.toOptimizedBuffer()
```

## API Reference

### Constructor & Factory

- `OptimizedBuffer.create(width: number, height: number, options?: { respectAlpha?: boolean })`

### Properties

- `buffers` - Direct access to typed arrays
- `respectAlpha` - Alpha blending mode
- `id` - Unique buffer identifier

### Methods

- `getWidth(): number`
- `getHeight(): number`
- `setRespectAlpha(respectAlpha: boolean): void`
- `clear(bg?: RGBA, clearChar?: string): void`
- `clearRect(x: number, y: number, width: number, height: number, bg: RGBA): void`
- `setCell(x: number, y: number, char: string, fg: RGBA, bg: RGBA, attributes?: number): void`
- `setCellWithAlphaBlending(...): void`
- `get(x: number, y: number): CellData | null`
- `drawText(...): void`
- `drawBox(...): void`
- `drawBoxWithTitle(...): void`
- `blit(source: OptimizedBuffer, x: number, y: number): void`
- `blitRegion(...): void`
- `blitWithAlpha(...): void`
- `merge(source: OptimizedBuffer, x: number, y: number): void`
- `mergeRegion(...): void`

## Related Modules

- [Text Buffer](./text-buffer.md) - Higher-level text operations
- [Rendering](./rendering.md) - Integration with renderer
- [Zig](./zig.md) - Native acceleration layer
- [Filters](./filters.md) - Post-processing effects