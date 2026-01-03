# Getting Started with OpenTUI

> **Quick Navigation:** [Components](./components.md) | [Layout](./layout.md) | [Events](./events.md) | [Animation](./animation.md) | [Rendering](./rendering.md)

OpenTUI is a terminal UI framework for building rich, interactive command-line applications with a React-like component model.

## Installation

```bash
npm install @opentui/core
# or
bun add @opentui/core
```

## Basic Example

```typescript
import { CliRenderer, BoxRenderable, TextRenderable } from '@opentui/core';

// Create the renderer
const renderer = new CliRenderer(
  lib,           // Native library handle
  rendererPtr,   // Renderer pointer
  process.stdin,
  process.stdout,
  80,           // Width
  24,           // Height
  {}            // Config
);

// Create a box with text inside
const box = new BoxRenderable('main-box', {
  width: '100%',
  height: '100%',
  border: true,
  borderStyle: 'rounded',
  padding: 2
});

const text = new TextRenderable('hello', {
  text: 'Hello, OpenTUI!'
});

// Build component tree
box.add(text);
renderer.root.add(box);

// Start rendering
renderer.start();
```

## Core Concepts

### Renderables
Everything you see on screen is a Renderable - the base class for all UI components.
→ Learn more: [Components Guide](./components.md)

### Layout System
OpenTUI uses Yoga (Facebook's flexbox implementation) for layout:
- Supports flexbox properties
- Percentage-based sizing
- Absolute and relative positioning
→ Learn more: [Layout System](./layout.md)

### Event System
- Keyboard events flow through focused components
- Mouse events use bubbling similar to the web
- Components can prevent default behavior
→ Learn more: [Event Handling](./events.md)

### Render Loop
1. Input processing
2. Layout calculation
3. Component rendering to buffer
4. Buffer diff and terminal update
→ Learn more: [Rendering System](./rendering.md)

## Next Steps

- **Build UI:** Start with the [Components Guide](./components.md) to learn about available components
- **Handle Input:** Read the [Events Guide](./events.md) for keyboard and mouse handling
- **Add Motion:** Check out [Animations](./animation.md) for transitions and effects
- **Optimize:** Learn about performance in the [Rendering Guide](./rendering.md)

## Related Topics

- [Components](./components.md) - Built-in UI components and how to use them
- [Layout System](./layout.md) - Flexbox layout and positioning
- [Event Handling](./events.md) - Keyboard and mouse interaction
- [Animation](./animation.md) - Creating smooth animations
- [Rendering](./rendering.md) - Understanding the render pipeline
