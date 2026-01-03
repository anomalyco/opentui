# Lib Utilities Module

The lib module provides essential utility functions and classes that power OpenTUI's core functionality, including styling, borders, fonts, and input handling.

## Overview

This module contains foundational utilities used throughout OpenTUI for text styling, border rendering, ASCII fonts, color management, and keyboard/mouse input parsing.

## Core Components

### RGBA Color Management

```typescript
import { RGBA } from '@opentui/core/lib'

const red = new RGBA(255, 0, 0, 255)
const semitransparent = new RGBA(0, 0, 255, 128)

// Color blending
const blended = RGBA.blend(red, semitransparent)

// Color interpolation
const gradient = RGBA.interpolate(red, blue, 0.5)
```

### Styled Text

Rich text formatting with ANSI escape sequences:

```typescript
import { StyledText, parseStyledText } from '@opentui/core/lib'

const styled = new StyledText('Hello World')
  .fg(255, 0, 0)
  .bg(0, 0, 255)
  .bold()
  .underline()

const ansi = styled.toANSI()

// Parse existing styled text
const parsed = parseStyledText('\x1b[31mRed Text\x1b[0m')
```

### Border Rendering

Flexible border system with multiple styles:

```typescript
import { Border, BorderStyle } from '@opentui/core/lib'

const border = new Border({
  style: BorderStyle.Double,
  fg: new RGBA(255, 255, 255, 255),
  padding: 2
})

// Render border to buffer
border.render(buffer, x, y, width, height)

// Available styles
BorderStyle.Single   // ┌─┐
BorderStyle.Double   // ╔═╗
BorderStyle.Rounded  // ╭─╮
BorderStyle.Heavy    // ┏━┓
```

### ASCII Fonts

Decorative text rendering with ASCII art fonts:

```typescript
import { ASCIIFont } from '@opentui/core/lib'

const font = new ASCIIFont({
  font: 'block',
  fg: new RGBA(255, 255, 0, 255)
})

const rendered = font.render('HELLO')
// ██╗  ██╗███████╗██╗     ██╗      ██████╗ 
// ██║  ██║██╔════╝██║     ██║     ██╔═══██╗
// ███████║█████╗  ██║     ██║     ██║   ██║
// ██╔══██║██╔══╝  ██║     ██║     ██║   ██║
// ██║  ██║███████╗███████╗███████╗╚██████╔╝
// ╚═╝  ╚═╝╚══════╝╚══════╝╚══════╝ ╚═════╝ 
```

## Input Handling

### KeyHandler

Sophisticated keyboard input management:

```typescript
import { KeyHandler } from '@opentui/core/lib'

const handler = new KeyHandler()

handler.on('ctrl+c', () => process.exit(0))
handler.on('arrow-up', () => moveCursor(-1))
handler.on('enter', () => submitForm())

// Complex key combinations
handler.on('ctrl+shift+p', () => openCommandPalette())

// Key sequences
handler.sequence(['g', 'g'], () => goToTop())
handler.sequence(['d', 'd'], () => deleteLine())
```

### Mouse Parsing

Parse terminal mouse events:

```typescript
import { parseMouse } from '@opentui/core/lib'

process.stdin.on('data', (data) => {
  const mouse = parseMouse(data)
  if (mouse) {
    console.log(`Click at ${mouse.x}, ${mouse.y}`)
    if (mouse.button === 'left') handleLeftClick(mouse)
    if (mouse.type === 'wheel') handleScroll(mouse.delta)
  }
})
```

## Text Processing

### HAST Styled Text

Integration with syntax highlighting using HAST:

```typescript
import { hastToStyledText } from '@opentui/core/lib'

const hastTree = {
  type: 'element',
  tagName: 'span',
  properties: { className: ['keyword'] },
  children: [{ type: 'text', value: 'function' }]
}

const styled = hastToStyledText(hastTree, {
  theme: 'monokai',
  background: false
})
```

### Selection Management

Text selection and clipboard operations:

```typescript
import { Selection } from '@opentui/core/lib'

const selection = new Selection()
selection.start(10, 5)
selection.extend(25, 8)

const selected = selection.getSelectedText(buffer)
const coords = selection.getCoordinates()

// Visual feedback
selection.highlight(buffer, { bg: [100, 100, 100, 255] })
```

## Layout Utilities

### Yoga Layout Options

Flexbox layout configuration:

```typescript
import { yogaOptions } from '@opentui/core/lib'

const layout = yogaOptions({
  flexDirection: 'row',
  justifyContent: 'space-between',
  alignItems: 'center',
  padding: 10,
  gap: 5
})
```

### TrackedNode

DOM-like node tracking for component trees:

```typescript
import { TrackedNode } from '@opentui/core/lib'

const root = new TrackedNode('root')
const child = new TrackedNode('child')
root.appendChild(child)

// Tree traversal
root.traverse((node) => {
  console.log(node.id)
})

// Find nodes
const found = root.find((node) => node.id === 'child')
```

## Utilities

### Output Capture

Capture and redirect terminal output:

```typescript
import { captureOutput } from '@opentui/core/lib'

const restore = captureOutput((output) => {
  // Process captured output
  logger.log(output)
})

console.log('This will be captured')
restore() // Restore normal output
```

### Parse Keypress

Low-level keypress parsing:

```typescript
import { parseKeypress } from '@opentui/core/lib'

const key = parseKeypress(Buffer.from([27, 91, 65]))
// { name: 'up', ctrl: false, shift: false, meta: false }
```

## API Reference

### Exports

- `RGBA` - Color representation and manipulation
- `StyledText` - Text with ANSI styling
- `Border` - Border rendering utilities
- `BorderStyle` - Border style constants
- `ASCIIFont` - ASCII art text rendering
- `KeyHandler` - Keyboard event management
- `parseMouse` - Mouse event parsing
- `parseKeypress` - Keypress parsing
- `Selection` - Text selection management
- `TrackedNode` - Node tree management
- `hastToStyledText` - HAST to styled text conversion
- `yogaOptions` - Layout configuration helpers
- `captureOutput` - Output redirection

## Related Modules

- [Components](./components.md) - Uses lib utilities for rendering
- [Text Buffer](./text-buffer.md) - Text manipulation and styling
- [Events](./events.md) - Input event handling