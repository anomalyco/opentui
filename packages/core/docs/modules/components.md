# Components

> **Quick Navigation:** [Getting Started](./getting-started.md) | [Layout](./layout.md) | [Events](./events.md) | [Animation](./animation.md) | [Rendering](./rendering.md)

OpenTUI provides several built-in components for building terminal UIs.

## Box Component

The most fundamental container component, similar to `div` in HTML.

```typescript
import { BoxRenderable } from '@opentui/core';

const box = new BoxRenderable('my-box', {
  // Sizing
  width: 50,
  height: 20,
  
  // Border
  border: true,
  borderStyle: 'double', // 'single' | 'double' | 'rounded' | 'heavy'
  borderColor: '#00ff00',
  
  // Background
  backgroundColor: '#1e1e1e',
  
  // Layout
  padding: 2,
  margin: 1,
  
  // Flexbox
  flexDirection: 'column',
  alignItems: 'center',
  justifyContent: 'space-between'
});

// Custom border characters
const customBox = new BoxRenderable('custom', {
  border: true,
  customBorderChars: {
    topLeft: '╭',
    topRight: '╮',
    bottomLeft: '╰',
    bottomRight: '╯',
    horizontal: '─',
    vertical: '│'
  }
});
```

## Text Component

Displays text with optional styling and word wrapping.

```typescript
import { TextRenderable, RGBA } from '@opentui/core';

const text = new TextRenderable('my-text', {
  text: 'Hello World',
  color: RGBA.fromHex('#ffffff'),
  backgroundColor: RGBA.fromHex('#0000ff'),
  
  // Text alignment
  align: 'center', // 'left' | 'center' | 'right'
  
  // Word wrap
  wrap: true,
  
  // Selection
  selectable: true,
  selectionBg: '#ffff00',
  selectionFg: '#000000'
});

// Styled text with markup
const styledText = new TextRenderable('styled', {
  text: '{red}Error:{/} {bold}File not found{/}',
  parseMarkup: true
});
```

## Input Component

Single-line text input field.

```typescript
import { InputRenderable } from '@opentui/core';

const input = new InputRenderable('username', {
  placeholder: 'Enter username...',
  value: '',
  
  // Styling
  focusedBorderColor: '#00ff00',
  cursorStyle: 'block', // 'block' | 'line' | 'underline'
  
  // Validation
  maxLength: 20,
  pattern: /^[a-zA-Z0-9]+$/,
  
  // Events
  onChange: (value) => {
    console.log('Input changed:', value);
  },
  onSubmit: (value) => {
    console.log('Submitted:', value);
  }
});

// Password input
const password = new InputRenderable('password', {
  type: 'password',
  mask: '*'
});
```

## Select Component

Dropdown selection list.

```typescript
import { SelectRenderable } from '@opentui/core';

const select = new SelectRenderable('color-select', {
  options: [
    { name: 'Red', value: '#ff0000' },
    { name: 'Green', value: '#00ff00' },
    { name: 'Blue', value: '#0000ff' }
  ],
  
  selected: 0,
  visibleOptions: 5, // Max visible at once
  
  // Styling
  selectedBg: '#333333',
  selectedFg: '#ffffff',
  
  // Events
  onChange: (option, index) => {
    console.log('Selected:', option.name);
  }
});
```

## ASCII Font Component

Display text using ASCII art fonts.

```typescript
import { ASCIIFontRenderable, fonts } from '@opentui/core';

const title = new ASCIIFontRenderable('title', {
  text: 'OpenTUI',
  font: fonts.block, // Built-in fonts: tiny, block, shade, slick
  
  // Colors (supports gradients)
  fg: [
    RGBA.fromHex('#ff0000'),
    RGBA.fromHex('#00ff00'),
    RGBA.fromHex('#0000ff')
  ]
});

// Custom font
import customFont from './my-font.json';

const custom = new ASCIIFontRenderable('custom', {
  text: 'Custom',
  font: customFont as FontDefinition
});
```

## Creating Custom Components

Extend the Renderable class to create custom components:

```typescript
import { Renderable, OptimizedBuffer, RGBA } from '@opentui/core';

class ProgressBar extends Renderable {
  private progress: number = 0;
  
  setProgress(value: number) {
    this.progress = Math.max(0, Math.min(1, value));
    this.needsUpdate();
  }
  
  protected renderSelf(buffer: OptimizedBuffer, deltaTime: number): void {
    const width = this.computedWidth;
    const filled = Math.floor(width * this.progress);
    
    // Draw filled portion
    for (let x = 0; x < filled; x++) {
      buffer.setCell(
        this.x + x,
        this.y,
        '█',
        RGBA.fromHex('#00ff00'),
        RGBA.fromHex('#000000')
      );
    }
    
    // Draw empty portion
    for (let x = filled; x < width; x++) {
      buffer.setCell(
        this.x + x,
        this.y,
        '░',
        RGBA.fromHex('#333333'),
        RGBA.fromHex('#000000')
      );
    }
  }
}
```

## Related Topics

### Layout & Positioning
- [Layout System](./layout.md) - Learn about flexbox properties used by components
- [Getting Started](./getting-started.md#core-concepts) - Understanding component hierarchy

### Interactivity
- [Event Handling](./events.md) - Add keyboard and mouse interaction to components
- [Event Handling: Forms](./events.md#form-handling) - Building interactive forms with inputs

### Visual Effects
- [Animation](./animation.md) - Animate component properties
- [Animation: Transitions](./animation.md#transition-effects) - Page and component transitions
- [Rendering: Gradients](./rendering.md#gradient-rendering) - Advanced visual effects

### Performance
- [Rendering: Optimization](./rendering.md#performance-tips) - Component rendering best practices
- [Rendering: Virtual Scrolling](./rendering.md#virtual-scrolling) - Efficient list rendering

## Component Patterns

### Container Components
Components like `BoxRenderable` are containers that use [flexbox layout](./layout.md#flexbox-properties) to arrange children. See the [Layout Guide](./layout.md) for positioning strategies.

### Interactive Components
`InputRenderable` and other interactive components rely on the [event system](./events.md). Learn about [focus management](./events.md#focus-management) and [keyboard handling](./events.md#keyboard-events).

### Custom Components
Build your own components by extending `Renderable`. See [Rendering](./rendering.md#custom-cell-rendering) for custom rendering techniques and [Animation](./animation.md#property-animations) for adding motion.

## Next Steps

- **Layout:** Learn [flexbox layout](./layout.md) to arrange components
- **Events:** Add [interactivity](./events.md) with keyboard and mouse handling  
- **Animation:** Create [smooth transitions](./animation.md) between states
- **Optimization:** Improve performance with [rendering techniques](./rendering.md)
