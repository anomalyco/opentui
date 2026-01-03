# Text Buffer Module

The text-buffer module provides efficient text manipulation and buffer management for terminal rendering operations.

## Overview

The TextBuffer class manages character-based content with styling, providing optimized operations for terminal UI rendering including diffing, merging, and viewport management.

## Core Components

### TextBuffer

Main class for managing text content with ANSI styling and efficient updates.

```typescript
import { TextBuffer } from '@opentui/core'

const buffer = new TextBuffer(80, 24)
buffer.write(0, 0, 'Hello, World!')
buffer.setStyle(0, 0, 13, { fg: [255, 0, 0, 255] })
```

## Key Features

### Buffer Operations

- **Write Operations**: Direct character writing with position control
- **Style Management**: Apply ANSI colors and text decorations
- **Diff Generation**: Efficient change detection between buffer states
- **Viewport Support**: Handle scrolling and partial rendering
- **Clear Operations**: Reset regions or entire buffer

### Text Manipulation

```typescript
// Write styled text
buffer.writeStyled(10, 5, 'Important', {
  fg: [255, 255, 0, 255],
  bold: true,
  underline: true
})

// Extract regions
const region = buffer.getRegion(0, 0, 40, 10)

// Merge buffers
buffer.merge(otherBuffer, 20, 10)
```

## Performance Optimization

### Dirty Tracking

Tracks modified regions to minimize rendering updates:

```typescript
buffer.write(0, 0, 'Changed')
const dirty = buffer.getDirtyRegions()
// Only re-render dirty regions
```

### Buffer Pooling

Reuse buffer instances to reduce allocations:

```typescript
const pool = new TextBufferPool(10)
const buffer = pool.acquire(80, 24)
// Use buffer...
pool.release(buffer)
```

## Integration

### With Renderables

TextBuffer integrates seamlessly with the rendering system:

```typescript
class CustomRenderable extends Renderable {
  private buffer: TextBuffer
  
  render(target: TextBuffer) {
    target.merge(this.buffer, this.x, this.y)
  }
}
```

### With Console Output

Direct terminal output support:

```typescript
const output = buffer.toANSI()
process.stdout.write(output)
```

## Advanced Usage

### Double Buffering

Implement smooth animations with double buffering:

```typescript
let frontBuffer = new TextBuffer(80, 24)
let backBuffer = new TextBuffer(80, 24)

function render() {
  // Render to back buffer
  backBuffer.clear()
  renderScene(backBuffer)
  
  // Swap buffers
  [frontBuffer, backBuffer] = [backBuffer, frontBuffer]
  
  // Output front buffer
  console.write(frontBuffer.toANSI())
}
```

### Custom Encodings

Support for different character encodings:

```typescript
const buffer = new TextBuffer(80, 24, {
  encoding: 'utf-8',
  lineEnding: '\n'
})
```

## API Reference

### Constructor

```typescript
new TextBuffer(width: number, height: number, options?: TextBufferOptions)
```

### Methods

- `write(x: number, y: number, text: string): void`
- `writeStyled(x: number, y: number, text: string, style: TextStyle): void`
- `clear(x?: number, y?: number, width?: number, height?: number): void`
- `getChar(x: number, y: number): string`
- `getStyle(x: number, y: number): TextStyle`
- `setStyle(x: number, y: number, length: number, style: TextStyle): void`
- `getRegion(x: number, y: number, width: number, height: number): TextBuffer`
- `merge(buffer: TextBuffer, x: number, y: number): void`
- `getDirtyRegions(): DirtyRegion[]`
- `toANSI(): string`
- `clone(): TextBuffer`

## Related Modules

- [Buffer](./buffer.md) - Lower-level buffer operations
- [Rendering](./rendering.md) - Integration with rendering system
- [Components](./components.md) - Usage in UI components