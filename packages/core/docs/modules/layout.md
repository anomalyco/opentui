# Layout System

OpenTUI uses Facebook's Yoga layout engine, providing flexbox layout for terminal UIs.

## Basic Layout

```typescript
const container = new BoxRenderable('container', {
  width: '100%',
  height: '100%',
  flexDirection: 'column'
});

const header = new BoxRenderable('header', {
  height: 3,
  width: '100%',
  backgroundColor: '#333333'
});

const content = new BoxRenderable('content', {
  flexGrow: 1, // Take remaining space
  width: '100%'
});

const footer = new BoxRenderable('footer', {
  height: 3,
  width: '100%',
  backgroundColor: '#333333'
});

container.add(header);
container.add(content);
container.add(footer);
```

## Flexbox Properties

### Container Properties

```typescript
const flex = new BoxRenderable('flex', {
  // Direction
  flexDirection: 'row', // 'row' | 'column' | 'row-reverse' | 'column-reverse'
  
  // Alignment
  alignItems: 'center',     // Cross-axis alignment
  justifyContent: 'center', // Main-axis alignment
  
  // Wrapping
  flexWrap: 'wrap', // 'nowrap' | 'wrap' | 'wrap-reverse'
  
  // Gap between items
  gap: 2
});
```

### Item Properties

```typescript
const item = new BoxRenderable('item', {
  // Flex properties
  flexGrow: 1,    // Grow factor
  flexShrink: 1,  // Shrink factor
  flexBasis: 100, // Base size before flex
  
  // Self alignment
  alignSelf: 'stretch' // Override parent's alignItems
});
```

## Grid Layout

Create grid layouts using nested flexbox:

```typescript
function createGrid(rows: number, cols: number) {
  const grid = new BoxRenderable('grid', {
    flexDirection: 'column',
    width: '100%',
    height: '100%'
  });
  
  for (let r = 0; r < rows; r++) {
    const row = new BoxRenderable(`row-${r}`, {
      flexDirection: 'row',
      height: `${100 / rows}%`,
      width: '100%'
    });
    
    for (let c = 0; c < cols; c++) {
      const cell = new BoxRenderable(`cell-${r}-${c}`, {
        width: `${100 / cols}%`,
        height: '100%',
        border: true
      });
      row.add(cell);
    }
    
    grid.add(row);
  }
  
  return grid;
}
```

## Absolute Positioning

```typescript
const overlay = new BoxRenderable('overlay', {
  position: 'absolute',
  top: 10,
  left: 10,
  width: 40,
  height: 10,
  backgroundColor: 'rgba(0, 0, 0, 0.8)',
  zIndex: 100
});
```

## Responsive Layout

```typescript
class ResponsiveContainer extends BoxRenderable {
  constructor(id: string) {
    super(id, {});
    this.updateLayout();
  }
  
  updateLayout() {
    const width = this.parent?.computedWidth || 80;
    
    if (width < 40) {
      // Mobile layout
      this.setOptions({
        flexDirection: 'column',
        padding: 1
      });
    } else if (width < 80) {
      // Tablet layout
      this.setOptions({
        flexDirection: 'row',
        flexWrap: 'wrap',
        padding: 2
      });
    } else {
      // Desktop layout
      this.setOptions({
        flexDirection: 'row',
        flexWrap: 'nowrap',
        padding: 3
      });
    }
  }
}
```

## Scrollable Content

```typescript
class ScrollableBox extends BoxRenderable {
  private scrollOffset = 0;
  
  constructor(id: string, options: BoxOptions) {
    super(id, {
      ...options,
      overflow: 'hidden'
    });
    
    this.onMouseScroll = (event) => {
      if (event.scroll.direction === 'up') {
        this.scrollOffset = Math.max(0, this.scrollOffset - 1);
      } else {
        this.scrollOffset = Math.min(
          this.getContentHeight() - this.computedHeight,
          this.scrollOffset + 1
        );
      }
      this.needsUpdate();
    };
  }
  
  protected renderSelf(buffer: OptimizedBuffer, deltaTime: number): void {
    // Render with scroll offset
    const originalY = this.y;
    this.y -= this.scrollOffset;
    super.renderSelf(buffer, deltaTime);
    this.y = originalY;
  }
}
```

## Related Topics

### Component Layout
- [Components: Box](./components.md#box-component) - Container component with flexbox support
- [Components: Text](./components.md#text-component) - Text alignment and wrapping
- [Getting Started](./getting-started.md#core-concepts) - Layout fundamentals

### Dynamic Layouts
- [Events: Window](./events.md#window-events) - Handling terminal resize
- [Animation: Properties](./animation.md#property-animations) - Animating layout changes
- [Animation: Transitions](./animation.md#transition-effects) - Smooth layout transitions

### Performance
- [Rendering: Optimization](./rendering.md#performance-tips) - Layout performance tips
- [Rendering: Virtual Scrolling](./rendering.md#virtual-scrolling) - Efficient scrollable layouts
- [Rendering: Culling](./rendering.md#render-optimization-strategies) - Skip rendering off-screen elements

## Layout Patterns

### Common Patterns
For implementation examples of common layouts:
- **Forms:** See [Events: Form Handling](./events.md#form-handling) and [Components: Input](./components.md#input-component)
- **Grids:** Check [Components: Patterns](./components.md#component-patterns)
- **Modals/Dialogs:** Review [Animation: Toast](./animation.md#notification-toast-animation)
- **Sidebars:** See flexbox examples above

### Responsive Techniques
- Use percentage widths: `width: '50%'`
- Flexbox grow/shrink: `flexGrow: 1`
- Media queries via terminal size detection
- See [Events](./events.md) for resize handling

### Layout Animation
Combine layout with smooth animations:
- [Animation: Timeline](./animation.md#timeline-animations) - Orchestrate multiple layout changes
- [Animation: Sequencing](./animation.md#animation-sequencing) - Chain layout animations
- [Components](./components.md) - Animated component examples

## Best Practices

1. **Use Flexbox:** Leverage flexbox for responsive layouts instead of absolute positioning
2. **Percentage Sizing:** Use percentages for responsive designs
3. **Container Components:** Wrap related items in [Box components](./components.md#box-component)
4. **Virtual Scrolling:** For long lists, implement [virtual scrolling](./rendering.md#virtual-scrolling)
5. **Layout Caching:** Cache complex layouts to improve [rendering performance](./rendering.md#caching-complex-renders)

## Next Steps

- **Build UIs:** Create interfaces with the [component library](./components.md)
- **Add Interaction:** Make layouts interactive with [event handling](./events.md)
- **Animate Changes:** Add motion with the [animation system](./animation.md)
- **Optimize Performance:** Learn [rendering techniques](./rendering.md)
