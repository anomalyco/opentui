# MouseEvent

Represents a mouse event in the terminal UI. Handles mouse interactions including clicks, drags, scrolls, and hover events.

## Constructor

```typescript
new MouseEvent(target: Renderable | null, attributes: RawMouseEvent & { source?: Renderable })
```

### Parameters

#### target

Type: `Renderable | null`

#### attributes

Type: `RawMouseEvent & { source?: Renderable }`

## Properties

### type

Type: `MouseEventType`

The type of mouse event (down, up, move, drag, drag-end, drop, over, out, scroll)

### button

Type: `number`

Which mouse button was pressed (0=left, 1=middle, 2=right)

### x

Type: `number`

X coordinate of the mouse event relative to the terminal

### y

Type: `number`

Y coordinate of the mouse event relative to the terminal

### source

Type: `Renderable`

The renderable that originally received the event

### modifiers

Type: `{
    shift: boolean
    alt: boolean
    ctrl: boolean
  }`

Keyboard modifiers active during the event

### scroll

Type: `ScrollInfo`

Scroll information if this is a scroll event

### target

Type: `Renderable | null`

The renderable that is the target of the event (may be different from source due to bubbling)

## Methods

### preventDefault()

Prevents the default action for this event from occurring

#### Signature

```typescript
preventDefault(): void
```

## Examples

```typescript
// Handle mouse clicks
renderable.onMouseDown = (event: MouseEvent) => {
  if (event.button === 0) { // Left click
    console.log(`Clicked at ${event.x}, ${event.y}`);
    event.preventDefault();
  }
};

// Handle mouse scroll
renderable.onMouseScroll = (event: MouseEvent) => {
  if (event.scroll.direction === 'up') {
    scrollUp();
  }
};
```

## See Also

- [Renderable](./Renderable.md) - Base class that handles mouse events
- [MouseEventType](../types/MouseEventType.md) - Event type enumeration
