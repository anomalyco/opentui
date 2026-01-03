# BorderStyle

Defines the visual style of borders used in box components.

## Type Definition

```typescript
type BorderStyle = 'single' | 'double' | 'rounded' | 'heavy';
```

## Values

### single
Single-line border using standard box-drawing characters:
- Horizontal: ─
- Vertical: │
- Corners: ┌ ┐ └ ┘

### double
Double-line border for emphasis:
- Horizontal: ═
- Vertical: ║
- Corners: ╔ ╗ ╚ ╝

### rounded
Single-line border with rounded corners for a softer appearance:
- Horizontal: ─
- Vertical: │
- Corners: ╭ ╮ ╰ ╯

### heavy
Bold/thick border for strong emphasis:
- Horizontal: ━
- Vertical: ┃
- Corners: ┏ ┓ ┗ ┛

## Examples

```typescript
// Basic single border
const box1 = new BoxRenderable('box1', {
  border: true,
  borderStyle: 'single'
});

// Double border for important content
const dialog = new BoxRenderable('dialog', {
  border: true,
  borderStyle: 'double',
  title: 'Confirm Action'
});

// Rounded border for friendly UI
const tooltip = new BoxRenderable('tooltip', {
  border: true,
  borderStyle: 'rounded',
  padding: 1
});

// Heavy border for critical alerts
const alert = new BoxRenderable('alert', {
  border: true,
  borderStyle: 'heavy',
  borderColor: '#ff0000'
});
```

## See Also

- [BoxOptions](../interfaces/BoxOptions.md) - Box configuration options
- [BorderCharacters](../interfaces/BorderCharacters.md) - Custom border character definitions