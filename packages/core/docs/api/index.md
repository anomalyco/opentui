# OpenTUI API Documentation

OpenTUI is a modern terminal UI framework that brings React-like component architecture to the terminal.

## Quick Links

### Module Documentation
Learn how to use OpenTUI with practical guides and examples:

- [Getting Started](../modules/guide.md) - Installation and basic usage
- [Components](../modules/components.md) - Built-in UI components
- [Layout System](../modules/layout.md) - Flexbox layout in the terminal
- [Event Handling](../modules/events.md) - Mouse and keyboard input
- [Animation](../modules/animation.md) - Smooth animations and transitions
- [Rendering](../modules/rendering.md) - Rendering pipeline and optimization

### API Reference

#### Core Classes
- [CliRenderer](./reference/classes/CliRenderer.md) - Main renderer managing the terminal
- [Renderable](./reference/classes/Renderable.md) - Base class for all components
- [OptimizedBuffer](./reference/classes/OptimizedBuffer.md) - High-performance rendering buffer

#### Components
- [BoxRenderable](./reference/classes/BoxRenderable.md) - Container component with borders
- [TextRenderable](./reference/classes/TextRenderable.md) - Text display with styling
- [InputRenderable](./reference/classes/InputRenderable.md) - Text input field
- [ASCIIFontRenderable](./reference/classes/ASCIIFontRenderable.md) - ASCII art text

#### Events
- [MouseEvent](./reference/classes/MouseEvent.md) - Mouse interaction handling
- [MouseEventType](./reference/types/MouseEventType.md) - Types of mouse events

#### Animation
- [Timeline](./reference/classes/Timeline.md) - Animation timeline system

#### Configuration Interfaces
- [BoxOptions](./reference/interfaces/BoxOptions.md) - Box component configuration
- [TextOptions](./reference/interfaces/TextOptions.md) - Text component configuration
- [InputRenderableOptions](./reference/interfaces/InputRenderableOptions.md) - Input field configuration
- [ASCIIFontOptions](./reference/interfaces/ASCIIFontOptions.md) - ASCII font configuration
- [CliRendererConfig](./reference/interfaces/CliRendererConfig.md) - Renderer configuration

#### Type Definitions
- [BorderStyle](./reference/types/BorderStyle.md) - Available border styles
- [MouseEventType](./reference/types/MouseEventType.md) - Mouse event types

## Quick Start Example

```typescript
import { CliRenderer, BoxRenderable, TextRenderable } from '@opentui/core';
import { RGBA } from '@opentui/core';

// Create the renderer
const renderer = new CliRenderer(lib, ptr, stdin, stdout, 80, 24, {
  backgroundColor: '#1e1e1e'
});

// Create a main container
const mainBox = new BoxRenderable('main', {
  width: '100%',
  height: '100%',
  border: true,
  borderStyle: 'rounded',
  title: 'My App',
  padding: 1
});

// Add some text
const text = new TextRenderable('greeting', {
  text: 'Welcome to OpenTUI!',
  color: RGBA.fromHex('#00ff00'),
  align: 'center'
});

// Build the UI tree
mainBox.add(text, 0);
renderer.root.add(mainBox, 0);

// Start rendering
renderer.start();
```

## Framework Integrations

OpenTUI provides React and Solid.js bindings for declarative UI development:

### React
```tsx
import { render, Box, Text } from '@opentui/react';

function App() {
  return (
    <Box border="rounded" padding={2}>
      <Text color="green">Hello from React!</Text>
    </Box>
  );
}

render(<App />);
```

### Solid.js
```tsx
import { render, Box, Text } from '@opentui/solid';

function App() {
  return (
    <Box border="rounded" padding={2}>
      <Text color="green">Hello from Solid!</Text>
    </Box>
  );
}

render(() => <App />);
```

## Features

- 🎨 **Rich Styling** - Colors, borders, backgrounds, and ASCII fonts
- 📐 **Flexbox Layout** - Powered by Yoga layout engine
- 🖱️ **Mouse Support** - Full mouse interaction including drag & drop
- ⌨️ **Keyboard Input** - Comprehensive keyboard handling
- 🎬 **Animations** - Smooth transitions and effects
- ⚡ **Performance** - Optimized double-buffered rendering
- 🔧 **Framework Support** - React and Solid.js bindings
- 🎯 **TypeScript** - Full type safety and IntelliSense

## Architecture

OpenTUI uses a component-based architecture similar to web frameworks:

1. **Components** inherit from `Renderable` base class
2. **Layout** calculated using Yoga flexbox engine
3. **Rendering** uses double-buffered `OptimizedBuffer`
4. **Events** bubble up through component tree
5. **Animations** managed by `Timeline` system

## Contributing

See [CONTRIBUTING.md](https://github.com/sst/opentui/blob/main/CONTRIBUTING.md) for development setup and guidelines.

## License

MIT - See [LICENSE](https://github.com/sst/opentui/blob/main/LICENSE)
