# OpenTUI Module Documentation

Complete documentation for all OpenTUI core modules, organized by functionality.

## Core Modules

### [Rendering](./rendering.md)
Core rendering system with double buffering, dirty region tracking, and frame management.

### [Buffer](./buffer.md)
High-performance `OptimizedBuffer` class with native Zig acceleration for terminal display operations.

### [Text Buffer](./text-buffer.md)
Efficient text manipulation and buffer management for terminal rendering with styling support.

### [Components](./components.md)
Built-in UI components including Box, Text, Input, Select, TabSelect, ASCIIFont, and FrameBuffer.

## Utility Modules

### [Lib](./lib.md)
Essential utilities including RGBA colors, styled text, borders, ASCII fonts, input handling, and selection management.

### [Utils](./utils.md)
Helper functions including `createTextAttributes` for simplified text styling.

### [Types](./types.md)
TypeScript type definitions, enums, and interfaces for type safety across the framework.

## Visual Effects

### [Animation](./animation.md)
Timeline-based animation system with easing functions, keyframes, and property interpolation.

### [Post-Processing Filters](./filters.md)
Real-time visual effects including blur, glow, distortion, vignette, and color transformations.

### [3D](./3d.md)
WebGPU and Three.js integration for 3D graphics, sprites, particles, and physics in the terminal.

## System Integration

### [Events](./events.md)
Event system for keyboard, mouse, resize, and custom events with bubbling and capturing.

### [Console](./console.md)
Terminal-based debugging console with output capture, filtering, and visual inspection.

### [Layout](./layout.md)
Flexbox-inspired layout system using Yoga for automatic component positioning.

## Native Performance

### [Zig](./zig.md)
High-performance native acceleration through FFI bindings for rendering and buffer operations.

## Module Categories

### Rendering Pipeline
1. **Buffer** - Low-level buffer operations
2. **Text Buffer** - Text-specific buffer management
3. **Rendering** - Core rendering loop
4. **Components** - UI component rendering
5. **Post-Processing Filters** - Visual effects

### Component System
1. **Components** - Built-in UI components
2. **Layout** - Component positioning
3. **Events** - User interaction
4. **Animation** - Component animation

### Development Tools
1. **Console** - Debug output and logging
2. **Types** - Type definitions
3. **Utils** - Helper functions

### Advanced Features
1. **3D** - 3D graphics support
2. **Zig** - Native acceleration
3. **Lib** - Core utilities

## Quick Start Examples

### Basic Rendering
```typescript
import { CliRenderer, BoxRenderable, TextRenderable } from '@opentui/core'

const renderer = new CliRenderer()
const box = new BoxRenderable('container', {
  width: 40,
  height: 10,
  border: true
})

const text = new TextRenderable('label', {
  content: 'Hello, OpenTUI!'
})

box.appendChild(text)
renderer.appendChild(box)
renderer.render()
```

### With Animation
```typescript
import { Timeline } from '@opentui/core'

const timeline = new Timeline()
timeline.add({
  target: box,
  property: 'x',
  from: 0,
  to: 40,
  duration: 1000,
  easing: 'easeInOut'
})
timeline.play()
```

### With Effects
```typescript
import { VignetteEffect, applyGrayscale } from '@opentui/core/post/filters'

const vignette = new VignetteEffect(0.5)
const buffer = renderer.getBuffer()

applyGrayscale(buffer)
vignette.apply(buffer)
renderer.render()
```

## API Reference

For detailed API documentation of types and methods, see the [reference](../reference/index.md) directory.
