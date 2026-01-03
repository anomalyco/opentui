# Types Module

The types module provides TypeScript type definitions, enums, and interfaces used throughout OpenTUI for type safety and consistency.

## Overview

This module exports core type definitions that ensure type safety across the OpenTUI framework, including text attributes, cursor styles, render contexts, and configuration options.

## Text Attributes

### Attribute Flags

Bitwise flags for text styling:

```typescript
import { TextAttributes } from '@opentui/core'

const TextAttributes = {
  NONE: 0,
  BOLD: 1 << 0,          // 1
  DIM: 1 << 1,           // 2
  ITALIC: 1 << 2,        // 4
  UNDERLINE: 1 << 3,     // 8
  BLINK: 1 << 4,         // 16
  INVERSE: 1 << 5,       // 32
  HIDDEN: 1 << 6,        // 64
  STRIKETHROUGH: 1 << 7  // 128
}
```

### Combining Attributes

Use bitwise operations to combine attributes:

```typescript
// Combine multiple attributes
const style = TextAttributes.BOLD | TextAttributes.UNDERLINE

// Check for attribute
const isBold = (style & TextAttributes.BOLD) !== 0

// Remove attribute
const withoutBold = style & ~TextAttributes.BOLD

// Toggle attribute
const toggled = style ^ TextAttributes.ITALIC
```

## Cursor Types

### CursorStyle

Terminal cursor appearance:

```typescript
type CursorStyle = "block" | "line" | "underline"

// Usage
renderer.setCursorStyle("block")
renderer.setCursorStyle("line")     // Vertical bar
renderer.setCursorStyle("underline") // Horizontal underscore
```

## Debug Overlay

### DebugOverlayCorner

Position for debug information display:

```typescript
enum DebugOverlayCorner {
  topLeft = 0,
  topRight = 1,
  bottomLeft = 2,
  bottomRight = 3
}

// Usage
renderer.setDebugOverlay(true, DebugOverlayCorner.topRight)
```

## Render Context

### RenderContext Interface

Context provided during rendering:

```typescript
interface RenderContext {
  // Add hit detection region
  addToHitGrid: (
    x: number, 
    y: number, 
    width: number, 
    height: number, 
    id: number
  ) => void
  
  // Get viewport dimensions
  width: () => number
  height: () => number
  
  // Mark for re-render
  needsUpdate: () => void
}

// Usage in renderable
class MyRenderable extends Renderable {
  render(buffer: Buffer, context: RenderContext) {
    // Register hit area
    context.addToHitGrid(this.x, this.y, this.width, this.height, this.id)
    
    // Check viewport
    if (this.x > context.width()) return
    
    // Request update
    if (this.animated) context.needsUpdate()
  }
}
```

## Selection State

### SelectionState Interface

Text selection tracking:

```typescript
interface SelectionState {
  anchor: { x: number; y: number }  // Selection start
  focus: { x: number; y: number }   // Selection end
  isActive: boolean                 // Selection exists
  isSelecting: boolean              // Currently selecting
}

// Usage
const selection: SelectionState = {
  anchor: { x: 10, y: 5 },
  focus: { x: 25, y: 7 },
  isActive: true,
  isSelecting: false
}

// Get selection bounds
const minX = Math.min(selection.anchor.x, selection.focus.x)
const maxX = Math.max(selection.anchor.x, selection.focus.x)
const minY = Math.min(selection.anchor.y, selection.focus.y)
const maxY = Math.max(selection.anchor.y, selection.focus.y)
```

## Color Types

### ColorInput

Flexible color input type:

```typescript
type ColorInput = string | RGBA | [number, number, number, number]

// All valid color inputs
const color1: ColorInput = "#ff0000"
const color2: ColorInput = "rgb(255, 0, 0)"
const color3: ColorInput = RGBA.fromValues(1, 0, 0, 1)
const color4: ColorInput = [255, 0, 0, 255]
```

## Component Option Types

Types are provided for all component configurations (imported from type definition files):

- `BoxOptions` - Box component configuration
- `TextOptions` - Text component options
- `InputRenderableOptions` - Input field configuration
- `SelectRenderableOptions` - Select dropdown options
- `TabSelectRenderableOptions` - Tab selector options
- `ASCIIFontOptions` - ASCII art font settings
- `FrameBufferOptions` - Frame buffer configuration
- `AnimationOptions` - Animation settings
- `TimelineOptions` - Timeline configuration
- `ConsoleOptions` - Console window options
- `CliRendererConfig` - Renderer configuration

## Layout Types

### LayoutOptions

Flexbox-style layout configuration:

```typescript
interface LayoutOptions {
  flexDirection?: 'row' | 'column' | 'row-reverse' | 'column-reverse'
  justifyContent?: 'flex-start' | 'center' | 'flex-end' | 'space-between' | 'space-around'
  alignItems?: 'flex-start' | 'center' | 'flex-end' | 'stretch'
  flexWrap?: 'nowrap' | 'wrap' | 'wrap-reverse'
  flex?: number
  flexGrow?: number
  flexShrink?: number
  flexBasis?: number | string
  padding?: number | [number, number] | [number, number, number, number]
  margin?: number | [number, number] | [number, number, number, number]
  gap?: number
  width?: number | string
  height?: number | string
  minWidth?: number | string
  minHeight?: number | string
  maxWidth?: number | string
  maxHeight?: number | string
}
```

## Border Types

### BorderConfig

Border configuration options:

```typescript
interface BorderConfig {
  style?: BorderStyle
  color?: ColorInput
  width?: number
  padding?: number | [number, number] | [number, number, number, number]
  margin?: number | [number, number] | [number, number, number, number]
  rounded?: boolean
}

type BorderStyle = 'single' | 'double' | 'rounded' | 'heavy'
type BorderSides = 'top' | 'right' | 'bottom' | 'left'
```

## Event Types

### Mouse Events

```typescript
interface MouseEvent {
  x: number
  y: number
  button: 'left' | 'right' | 'middle' | 'none'
  type: 'click' | 'move' | 'wheel' | 'down' | 'up'
  modifiers: {
    shift: boolean
    ctrl: boolean
    alt: boolean
    meta: boolean
  }
  delta?: number  // For wheel events
}
```

### Keyboard Events

```typescript
interface KeyEvent {
  key: string
  code: string
  modifiers: {
    shift: boolean
    ctrl: boolean
    alt: boolean
    meta: boolean
  }
  isComposing: boolean
}
```

## Utility Types

### Dimensions

```typescript
interface Dimensions {
  width: number
  height: number
}

interface Position {
  x: number
  y: number
}

interface Bounds {
  x: number
  y: number
  width: number
  height: number
}

interface Padding {
  top: number
  right: number
  bottom: number
  left: number
}
```

## Type Guards

Utility functions for type checking:

```typescript
// Check if value is RGBA
function isRGBA(value: any): value is RGBA {
  return value instanceof RGBA
}

// Check if value is color string
function isColorString(value: any): value is string {
  return typeof value === 'string' && 
    (value.startsWith('#') || value.startsWith('rgb'))
}

// Check if has selection
function hasSelection(state: SelectionState): boolean {
  return state.isActive && 
    (state.anchor.x !== state.focus.x || 
     state.anchor.y !== state.focus.y)
}
```

## Generic Types

### Callback Types

```typescript
type VoidCallback = () => void
type ValueCallback<T> = (value: T) => void
type Predicate<T> = (value: T) => boolean
type Mapper<T, U> = (value: T) => U
type Reducer<T, U> = (acc: U, value: T) => U
```

### Component Types

```typescript
type ComponentProps<T = {}> = T & {
  id?: string
  className?: string
  style?: Partial<CSSStyleDeclaration>
  children?: ReactNode
}

type RenderFunction = (
  buffer: OptimizedBuffer,
  context: RenderContext
) => void
```

## Usage Examples

### Type-Safe Component Creation

```typescript
import { BoxOptions, TextAttributes, RGBA } from '@opentui/core'

const boxConfig: BoxOptions = {
  width: 40,
  height: 20,
  border: true,
  borderStyle: 'double',
  padding: 2,
  fg: RGBA.fromValues(1, 1, 1, 1),
  bg: RGBA.fromValues(0, 0, 0.5, 0.8)
}

const textStyle = TextAttributes.BOLD | TextAttributes.UNDERLINE

const box = new BoxRenderable('myBox', boxConfig)
box.attributes = textStyle
```

### Type-Safe Event Handling

```typescript
function handleMouse(event: MouseEvent): void {
  if (event.type === 'click' && event.button === 'left') {
    console.log(`Clicked at ${event.x}, ${event.y}`)
  }
  
  if (event.modifiers.ctrl) {
    console.log('Ctrl key held')
  }
}

function handleKey(event: KeyEvent): void {
  if (event.key === 'Enter' && !event.modifiers.shift) {
    submitForm()
  }
}
```

## API Reference

### Exports

- `TextAttributes` - Text attribute flags
- `CursorStyle` - Cursor appearance type
- `DebugOverlayCorner` - Debug overlay positions
- `RenderContext` - Rendering context interface
- `SelectionState` - Text selection state
- All option interfaces from type definition files

## Related Modules

- [Components](./components.md) - Uses type definitions
- [Rendering](./rendering.md) - Uses RenderContext
- [Events](./events.md) - Event type definitions
- [Lib](./lib.md) - Color and style utilities