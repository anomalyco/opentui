# Event Handling

OpenTUI provides comprehensive keyboard and mouse event handling.

## Keyboard Events

```typescript
import { Renderable, ParsedKey } from '@opentui/core';

class MyComponent extends Renderable {
  constructor(id: string) {
    super(id, {
      onKeyDown: (key: ParsedKey) => {
        // Handle key press
        if (key.name === 'escape') {
          this.handleEscape();
          return true; // Prevent bubbling
        }
        
        // Arrow keys
        if (key.name === 'up') this.moveUp();
        if (key.name === 'down') this.moveDown();
        if (key.name === 'left') this.moveLeft();
        if (key.name === 'right') this.moveRight();
        
        // Modifiers
        if (key.ctrl && key.name === 'c') {
          this.copy();
        }
        
        // Regular characters
        if (key.name.length === 1) {
          this.handleCharacter(key.name);
        }
        
        return false; // Allow bubbling
      }
    });
  }
}
```

### ParsedKey Structure

```typescript
interface ParsedKey {
  name: string;      // Key name ('a', 'enter', 'escape', etc.)
  ctrl: boolean;     // Ctrl key held
  meta: boolean;     // Meta/Cmd key held
  shift: boolean;    // Shift key held
  option: boolean;   // Alt/Option key held
  sequence: string;  // Raw escape sequence
  raw: string;       // Raw input
  code?: string;     // Key code if available
}
```

### Common Key Names
- Letters: 'a' through 'z'
- Numbers: '0' through '9'
- Special: 'enter', 'escape', 'backspace', 'delete', 'tab', 'space'
- Navigation: 'up', 'down', 'left', 'right', 'home', 'end', 'pageup', 'pagedown'
- Function: 'f1' through 'f12'

## Mouse Events

```typescript
class ClickableComponent extends Renderable {
  private isHovered = false;
  private isDragging = false;
  private dragStart = { x: 0, y: 0 };
  
  constructor(id: string) {
    super(id, {
      onMouseDown: (event: MouseEvent) => {
        if (event.button === 0) { // Left click
          this.isDragging = true;
          this.dragStart = { x: event.x, y: event.y };
          event.preventDefault();
        } else if (event.button === 2) { // Right click
          this.showContextMenu(event.x, event.y);
        }
      },
      
      onMouseUp: (event: MouseEvent) => {
        if (this.isDragging) {
          this.isDragging = false;
          this.handleDrop(event.x, event.y);
        }
      },
      
      onMouseDrag: (event: MouseEvent) => {
        if (this.isDragging) {
          const dx = event.x - this.dragStart.x;
          const dy = event.y - this.dragStart.y;
          this.handleDrag(dx, dy);
        }
      },
      
      onMouseOver: (event: MouseEvent) => {
        this.isHovered = true;
        this.updateHoverState();
      },
      
      onMouseOut: (event: MouseEvent) => {
        this.isHovered = false;
        this.updateHoverState();
      },
      
      onMouseScroll: (event: MouseEvent) => {
        if (event.scroll.direction === 'up') {
          this.scrollUp(event.scroll.delta);
        } else {
          this.scrollDown(event.scroll.delta);
        }
      }
    });
  }
}
```

### MouseEvent Structure

```typescript
interface MouseEvent {
  type: MouseEventType;  // Event type
  button: number;        // 0=left, 1=middle, 2=right
  x: number;            // X coordinate in terminal
  y: number;            // Y coordinate in terminal
  modifiers: {
    shift: boolean;
    alt: boolean;
    ctrl: boolean;
  };
  scroll?: {
    direction: 'up' | 'down' | 'left' | 'right';
    delta: number;
  };
  target: Renderable | null;  // Target component
  source: Renderable;         // Source component
  
  preventDefault(): void;      // Stop default behavior
}
```

## Focus Management

```typescript
class FocusableList extends Renderable {
  private focusedIndex = 0;
  private items: Renderable[] = [];
  
  constructor(id: string) {
    super(id, {
      onKeyDown: (key) => {
        if (key.name === 'tab') {
          if (key.shift) {
            this.focusPrevious();
          } else {
            this.focusNext();
          }
          return true; // Prevent default tab behavior
        }
      }
    });
  }
  
  focusNext() {
    this.items[this.focusedIndex]?.blur();
    this.focusedIndex = (this.focusedIndex + 1) % this.items.length;
    this.items[this.focusedIndex]?.focus();
  }
  
  focusPrevious() {
    this.items[this.focusedIndex]?.blur();
    this.focusedIndex = (this.focusedIndex - 1 + this.items.length) % this.items.length;
    this.items[this.focusedIndex]?.focus();
  }
}
```

## Event Delegation

```typescript
class EventDelegate extends Renderable {
  private handlers = new Map<string, Function>();
  
  constructor(id: string) {
    super(id, {
      onMouseDown: (event) => {
        // Delegate to child components based on data attributes
        const target = event.target;
        if (target && target.data?.action) {
          const handler = this.handlers.get(target.data.action);
          if (handler) {
            handler(event);
          }
        }
      }
    });
  }
  
  registerHandler(action: string, handler: Function) {
    this.handlers.set(action, handler);
  }
  
  createButton(text: string, action: string) {
    const button = new BoxRenderable(`btn-${action}`, {
      padding: 1,
      border: true,
      data: { action } // Custom data for delegation
    });
    button.add(new TextRenderable('label', { text }));
    return button;
  }
}
```

## Global Shortcuts

```typescript
class Application extends Renderable {
  private shortcuts = new Map<string, Function>();
  
  constructor() {
    super('app', {
      onKeyDown: (key) => {
        const shortcut = this.getShortcutKey(key);
        const handler = this.shortcuts.get(shortcut);
        
        if (handler) {
          handler();
          return true; // Handled
        }
        
        return false; // Pass through
      }
    });
    
    // Register shortcuts
    this.registerShortcut('ctrl+s', () => this.save());
    this.registerShortcut('ctrl+o', () => this.open());
    this.registerShortcut('ctrl+q', () => this.quit());
  }
  
  private getShortcutKey(key: ParsedKey): string {
    const parts = [];
    if (key.ctrl) parts.push('ctrl');
    if (key.shift) parts.push('shift');
    if (key.alt) parts.push('alt');
    parts.push(key.name);
    return parts.join('+');
  }
  
  registerShortcut(keys: string, handler: Function) {
    this.shortcuts.set(keys, handler);
  }
}
```

## Related Topics

### Interactive Components
- [Components: Input](./components.md#input-component) - Text input with keyboard handling
- [Components: Custom](./components.md#custom-components) - Building interactive components
- [Getting Started](./getting-started.md#core-concepts) - Event system overview

### Visual Feedback
- [Animation: Properties](./animation.md#property-animations) - Animate on user interaction
- [Animation: Transitions](./animation.md#transition-effects) - Smooth state changes
- [Rendering: Effects](./rendering.md#advanced-rendering-techniques) - Visual feedback effects

### Layout Integration
- [Layout: Responsive](./layout.md#layout-patterns) - Handling resize events
- [Layout: Scrollable](./layout.md#scrollable-content) - Scroll event handling
- [Components: Box](./components.md#box-component) - Container event bubbling

## Event Patterns

### Form Handling
Build interactive forms using:
- [Components: Input](./components.md#input-component) - Text input fields
- [Layout: Forms](./layout.md#layout-patterns) - Form layout patterns
- [Animation: Validation](./animation.md#complex-animation-examples) - Animated validation feedback

### Drag and Drop
Implement drag operations with:
- Mouse event tracking (see examples above)
- [Animation: Movement](./animation.md#property-animations) - Smooth dragging
- [Rendering: Layers](./rendering.md#advanced-rendering-techniques) - Z-index management

### Keyboard Navigation
Create accessible interfaces:
- Tab order management
- Focus indicators with [Rendering: Effects](./rendering.md#shadow-effects)
- Keyboard shortcuts (see examples above)

## Best Practices

1. **Event Delegation:** Use bubbling for parent containers to handle child events
2. **Debouncing:** Throttle rapid events like scroll or mouse move
3. **Focus Management:** Maintain logical tab order for accessibility
4. **Visual Feedback:** Always provide feedback for user actions
5. **Prevent Default:** Stop propagation when handling events

## Troubleshooting

### Common Issues
- **Events not firing:** Check focus state and event bubbling
- **Multiple handlers:** Use `stopPropagation()` to prevent bubbling
- **Performance:** Debounce rapid events like mouse move
- **Focus issues:** Ensure components are focusable

### Debug Events
```typescript
class EventDebugger extends Renderable {
  constructor(id: string) {
    super(id, {
      onMouseDown: (e) => console.log('MouseDown:', e),
      onKeyDown: (k) => console.log('KeyDown:', k),
      // Log all events
    });
  }
}
```

## Next Steps

- **Build Forms:** Create interactive forms with [Components](./components.md)
- **Add Motion:** Respond to events with [Animations](./animation.md)
- **Optimize:** Handle events efficiently with [Rendering](./rendering.md) techniques
- **Layout:** Create responsive layouts that handle [resize events](./layout.md)
