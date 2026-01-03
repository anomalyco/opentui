# FrameBufferOptions

## Properties

| Property | Type | Required | Description |
|----------|------|----------|-------------|
| `alignItems` | `AlignString` |  |  |
| `bottom` | `number | string | string` |  |  |
| `buffered` | `boolean` |  |  |
| `enableLayout` | `boolean` |  |  |
| `flexBasis` | `number | string` |  |  |
| `flexDirection` | `FlexDirectionString` |  |  |
| `flexGrow` | `number` |  |  |
| `flexShrink` | `number` |  |  |
| `height` | `number` | ✓ |  |
| `justifyContent` | `JustifyString` |  |  |
| `left` | `number | string | string` |  |  |
| `live` | `boolean` |  |  |
| `margin` | `number | string | string` |  |  |
| `marginBottom` | `number | string | string` |  |  |
| `marginLeft` | `number | string | string` |  |  |
| `marginRight` | `number | string | string` |  |  |
| `marginTop` | `number | string | string` |  |  |
| `maxHeight` | `number` |  |  |
| `maxWidth` | `number` |  |  |
| `minHeight` | `number` |  |  |
| `minWidth` | `number` |  |  |
| `onKeyDown` | `object` |  | (key: ParsedKey) => void |
| `onMouseDown` | `object` |  | (event: MouseEvent) => void |
| `onMouseDrag` | `object` |  | (event: MouseEvent) => void |
| `onMouseDragEnd` | `object` |  | (event: MouseEvent) => void |
| `onMouseDrop` | `object` |  | (event: MouseEvent) => void |
| `onMouseMove` | `object` |  | (event: MouseEvent) => void |
| `onMouseOut` | `object` |  | (event: MouseEvent) => void |
| `onMouseOver` | `object` |  | (event: MouseEvent) => void |
| `onMouseScroll` | `object` |  | (event: MouseEvent) => void |
| `onMouseUp` | `object` |  | (event: MouseEvent) => void |
| `padding` | `number | string` |  |  |
| `paddingBottom` | `number | string` |  |  |
| `paddingLeft` | `number | string` |  |  |
| `paddingRight` | `number | string` |  |  |
| `paddingTop` | `number | string` |  |  |
| `position` | `PositionTypeString` |  |  |
| `respectAlpha` | `boolean` |  |  |
| `right` | `number | string | string` |  |  |
| `top` | `number | string | string` |  |  |
| `visible` | `boolean` |  |  |
| `width` | `number` | ✓ |  |
| `zIndex` | `number` |  |  |

## Example

```typescript
const options: FrameBufferOptions = {

};
```

## Related Types

- `AlignString`
- `FlexDirectionString`
- `JustifyString`
- `MouseEvent`
- `MouseEventType`
- `ParsedKey`
- `PositionTypeString`
- `Renderable`
- `ScrollInfo`
