# Utils Module  

The utils module provides utility functions for common operations in OpenTUI, including text attribute creation and other helper functions.

## Overview

This module contains helper functions that simplify common tasks when working with OpenTUI components and rendering.

## Text Attribute Utilities

### createTextAttributes

Create text attributes using a friendly object interface instead of bitwise operations:

```typescript
import { createTextAttributes } from '@opentui/core'

// Create attributes with object syntax
const attributes = createTextAttributes({
  bold: true,
  underline: true,
  italic: false
})

// Equivalent to:
// TextAttributes.BOLD | TextAttributes.UNDERLINE
```

### Usage Examples

```typescript
// No attributes (default)
const plain = createTextAttributes()
// Returns: 0

// Single attribute
const bold = createTextAttributes({ bold: true })
// Returns: 1

// Multiple attributes
const fancy = createTextAttributes({
  bold: true,
  italic: true,
  underline: true
})
// Returns: 13 (1 + 4 + 8)

// All attributes
const all = createTextAttributes({
  bold: true,
  dim: true,
  italic: true,
  underline: true,
  blink: true,
  inverse: true,
  hidden: true,
  strikethrough: true
})
// Returns: 255 (all bits set)
```

### Attribute Options

All options are optional and default to `false`:

```typescript
interface TextAttributeOptions {
  bold?: boolean         // Make text bold
  italic?: boolean       // Make text italic
  underline?: boolean    // Underline text
  dim?: boolean         // Dim/faint text
  blink?: boolean       // Blinking text
  inverse?: boolean     // Swap fg/bg colors
  hidden?: boolean      // Hide text (but preserve space)
  strikethrough?: boolean // Strike through text
}
```

## Integration with Components

### With Text Components

```typescript
import { TextRenderable, createTextAttributes } from '@opentui/core'

const text = new TextRenderable('myText', {
  content: 'Important Message',
  attributes: createTextAttributes({
    bold: true,
    underline: true
  })
})
```

### With Box Components

```typescript
import { BoxRenderable, createTextAttributes } from '@opentui/core'

const box = new BoxRenderable('myBox', {
  title: 'Alert',
  titleAttributes: createTextAttributes({
    bold: true,
    inverse: true
  })
})
```

### Dynamic Attribute Updates

```typescript
class InteractiveText extends TextRenderable {
  private baseAttributes = createTextAttributes({ bold: true })
  private hoverAttributes = createTextAttributes({ 
    bold: true, 
    underline: true,
    inverse: true
  })
  
  onMouseEnter() {
    this.attributes = this.hoverAttributes
  }
  
  onMouseLeave() {
    this.attributes = this.baseAttributes
  }
}
```

## Attribute Manipulation

### Combining with Existing Attributes

```typescript
// Start with some attributes
let attrs = createTextAttributes({ bold: true })

// Add more attributes
attrs |= createTextAttributes({ underline: true })

// Remove attributes
attrs &= ~TextAttributes.BOLD

// Toggle attributes
attrs ^= TextAttributes.ITALIC

// Check for attributes
const isBold = (attrs & TextAttributes.BOLD) !== 0
```

### Attribute Presets

Create reusable attribute presets:

```typescript
const styles = {
  heading: createTextAttributes({ 
    bold: true, 
    underline: true 
  }),
  
  error: createTextAttributes({ 
    bold: true, 
    inverse: true 
  }),
  
  muted: createTextAttributes({ 
    dim: true 
  }),
  
  link: createTextAttributes({ 
    underline: true 
  }),
  
  code: createTextAttributes({ 
    inverse: true 
  })
}

// Use presets
text.attributes = styles.heading
errorText.attributes = styles.error
```

## Performance Considerations

### Caching Attributes

Since `createTextAttributes` performs bitwise operations, cache frequently used combinations:

```typescript
// Good - cache the result
class MyComponent {
  private static readonly HIGHLIGHT_ATTRS = createTextAttributes({
    bold: true,
    inverse: true
  })
  
  highlight() {
    this.attributes = MyComponent.HIGHLIGHT_ATTRS
  }
}

// Avoid - creates new value each time
class MyComponent {
  highlight() {
    this.attributes = createTextAttributes({
      bold: true,
      inverse: true
    }) // Recalculated each call
  }
}
```

## Best Practices

### Semantic Naming

Use descriptive names for attribute combinations:

```typescript
const semanticStyles = {
  primary: createTextAttributes({ bold: true }),
  secondary: createTextAttributes({ dim: true }),
  success: createTextAttributes({ bold: true }),
  warning: createTextAttributes({ bold: true, underline: true }),
  danger: createTextAttributes({ bold: true, inverse: true }),
  info: createTextAttributes({ italic: true }),
  disabled: createTextAttributes({ dim: true, strikethrough: true })
}
```

### Terminal Compatibility

Not all terminals support all attributes:

```typescript
// Most compatible
const basic = createTextAttributes({
  bold: true,      // Widely supported
  underline: true  // Widely supported
})

// Less compatible
const advanced = createTextAttributes({
  italic: true,       // Not all terminals
  blink: true,        // Often disabled
  strikethrough: true // Limited support
})

// Check terminal capabilities
const supportsItalic = process.env.TERM_PROGRAM !== 'Apple_Terminal'
const attrs = createTextAttributes({
  bold: true,
  italic: supportsItalic
})
```

## Examples

### Status Indicators

```typescript
function getStatusAttributes(status: string) {
  switch (status) {
    case 'running':
      return createTextAttributes({ bold: true, blink: true })
    case 'success':
      return createTextAttributes({ bold: true })
    case 'error':
      return createTextAttributes({ bold: true, inverse: true })
    case 'warning':
      return createTextAttributes({ bold: true, underline: true })
    case 'disabled':
      return createTextAttributes({ dim: true, strikethrough: true })
    default:
      return createTextAttributes()
  }
}
```

### Progressive Enhancement

```typescript
// Start with basic styling
let attributes = createTextAttributes({ bold: true })

// Add enhancements based on context
if (isImportant) {
  attributes |= TextAttributes.UNDERLINE
}

if (isError) {
  attributes |= TextAttributes.INVERSE
}

if (isDeprecated) {
  attributes |= TextAttributes.STRIKETHROUGH
}
```

## API Reference

### Functions

- `createTextAttributes(options?: TextAttributeOptions): number`
  - Creates text attributes from an options object
  - Returns a number with appropriate bits set
  - All options default to false

### Types

```typescript
interface TextAttributeOptions {
  bold?: boolean
  italic?: boolean
  underline?: boolean
  dim?: boolean
  blink?: boolean
  inverse?: boolean
  hidden?: boolean
  strikethrough?: boolean
}
```

## Related Modules

- [Types](./types.md) - TextAttributes enum definition
- [Components](./components.md) - Components that use attributes
- [Lib](./lib.md) - Additional text styling utilities
- [Rendering](./rendering.md) - How attributes are rendered