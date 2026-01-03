# MouseEventType

Enumeration of all mouse event types supported by OpenTUI.

## Type Definition

```typescript
type MouseEventType = 
  | 'down' 
  | 'up' 
  | 'move' 
  | 'drag' 
  | 'drag-end' 
  | 'drop' 
  | 'over' 
  | 'out' 
  | 'scroll';
```

## Values

### down
Mouse button pressed down. Triggered when user presses any mouse button.

### up
Mouse button released. Triggered when user releases a pressed mouse button.

### move
Mouse cursor moved without any buttons pressed. Used for hover effects.

### drag
Mouse moved while button is held down. Enables drag operations.

### drag-end
Drag operation completed. Fired when mouse button is released after dragging.

### drop
Item dropped onto a target. Fired on drop target when drag-end occurs over it.

### over
Mouse cursor entered a component's bounds. Used for hover states.

### out
Mouse cursor left a component's bounds. Used to clear hover states.

### scroll
Mouse wheel scrolled. Includes scroll direction and delta information.

## Examples

```typescript
// Handle different mouse events
renderable.onMouseDown = (event: MouseEvent) => {
  if (event.type === 'down' && event.button === 0) {
    console.log('Left button pressed');
  }
};

renderable.onMouseMove = (event: MouseEvent) => {
  if (event.type === 'move') {
    updateHoverPosition(event.x, event.y);
  }
};

renderable.onMouseDrag = (event: MouseEvent) => {
  if (event.type === 'drag') {
    updateDragPosition(event.x, event.y);
  }
};

renderable.onMouseScroll = (event: MouseEvent) => {
  if (event.type === 'scroll') {
    if (event.scroll.direction === 'up') {
      scrollUp(event.scroll.delta);
    } else {
      scrollDown(event.scroll.delta);
    }
  }
};

// Complete drag and drop implementation
class DraggableBox extends BoxRenderable {
  private dragging = false;
  private dragOffset = { x: 0, y: 0 };
  
  constructor(id: string, options: BoxOptions) {
    super(id, {
      ...options,
      onMouseDown: (event) => {
        if (event.type === 'down') {
          this.dragging = true;
          this.dragOffset = { 
            x: event.x - this.x,
            y: event.y - this.y 
          };
        }
      },
      onMouseDrag: (event) => {
        if (event.type === 'drag' && this.dragging) {
          this.x = event.x - this.dragOffset.x;
          this.y = event.y - this.dragOffset.y;
          this.needsUpdate();
        }
      },
      onMouseDragEnd: (event) => {
        if (event.type === 'drag-end') {
          this.dragging = false;
        }
      }
    });
  }
}
```

## See Also

- [MouseEvent](../classes/MouseEvent.md) - Mouse event class
- [Renderable](../classes/Renderable.md) - Base class handling mouse events