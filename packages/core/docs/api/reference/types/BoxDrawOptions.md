# BoxDrawOptions

## Properties

| Property | Type | Required | Description |
|----------|------|----------|-------------|
| `backgroundColor` | `ColorInput` | ✓ |  |
| `border` | `boolean | array` | ✓ |  |
| `borderColor` | `ColorInput` | ✓ |  |
| `borderStyle` | `BorderStyle` | ✓ |  |
| `customBorderChars` | `BorderCharacters` |  |  |
| `height` | `number` | ✓ |  |
| `shouldFill` | `boolean` |  |  |
| `title` | `string` |  |  |
| `titleAlignment` | `string` |  |  |
| `width` | `number` | ✓ |  |
| `x` | `number` | ✓ |  |
| `y` | `number` | ✓ |  |

## Example

```typescript
const options: BoxDrawOptions = {
  backgroundColor: undefined,
  border: undefined,
  borderColor: undefined,
  borderStyle: undefined
};
```

## Related Types

- `BorderCharacters`
- `BorderSides`
- `BorderStyle`
- `ColorInput`
- `RGBA`
