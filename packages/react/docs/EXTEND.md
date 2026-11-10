# OpenTUI React Component Extension

The `extend` function adds custom renderable classes to the component catalogue of the OpenTUI React reconciler. It works like `extend` in `@react-three/fiber`, which adds Three.js objects.

## Basic Usage

### Extending Components

```tsx
import { BoxRenderable, OptimizedBuffer, RGBA, type BoxOptions, type RenderContext } from "@opentui/core"
import { extend } from "@opentui/react"

class ConsoleButton extends BoxRenderable {
  public label: string = "Button"

  constructor(ctx: RenderContext, options: BoxOptions & { label: string }) {
    super(ctx, options)
    // Custom initialization

    this.height = 3
    this.width = 24
  }

  protected renderSelf(buffer: OptimizedBuffer): void {
    super.renderSelf(buffer)

    const centerX = this.x + Math.floor(this.width / 2 - this.label.length / 2)
    const centerY = this.y + Math.floor(this.height / 2)

    buffer.drawText(this.label, centerX, centerY, RGBA.fromInts(255, 255, 255, 255))
  }
}

declare module "@opentui/react" {
  interface OpenTUIComponents {
    consoleButton: typeof ConsoleButton
  }
}

// Extend components
extend({
  consoleButton: ConsoleButton,
})

// Now you can use them in JSX
function App() {
  return <consoleButton label="Click me!" />
}
```

React calls the constructor with `{ id, ...props }`. After construction, React assigns each prop to the instance again. In this example, React sets `label` after the class field sets it to `"Button"`.

`renderSelf()` is a [paint hook](https://opentui.com/docs/extend/custom-renderables#use-paint-hooks). It uses screen cell coordinates, so the example places the label relative to `this.x` and `this.y`.

## TypeScript Support

For full TypeScript support, declare your extended components with module augmentation:

```tsx
// In your component file or declaration file
declare module "@opentui/react" {
  interface OpenTUIComponents {
    consoleButton: typeof ConsoleButton
  }
}

// Then extend and use with full type safety
extend({
  consoleButton: ConsoleButton,
})

// TypeScript will now know about these components
<consoleButton label="Typed!" />
```

## API Reference

### `extend(components)`

Adds renderable components to the component catalogue.

**Parameters:**

- `components`: Object mapping component names to renderable constructors

**Returns:**

- `void`

### `getComponentCatalogue()`

Returns the current component catalogue. The reconciler uses it to find the class for each JSX element.

## Best Practices

1. **Declare types with module augmentation**: TypeScript then completes and checks the props of each custom element.

2. **Call `requestRender()`**: Call `requestRender()` in each property setter that changes what the component draws.

3. **Extend from appropriate base classes**: Use `BoxRenderable` for containers, `TextRenderable` for text, and so on.

## Limitations

- Extended components must extend from OpenTUI's core renderable classes
- `extend()` replaces an existing entry with the same name, including a built-in component. Use unique names.
- TypeScript support requires manual module augmentation declarations
