# TabSelectRenderableOptions

## Properties

| Property | Type | Required | Description |
|----------|------|----------|-------------|
| `alignItems` | `AlignString` |  |  |
| `backgroundColor` | `ColorInput` |  |  |
| `bottom` | `number | string | string` |  |  |
| `buffered` | `boolean` |  |  |
| `enableLayout` | `boolean` |  |  |
| `flexBasis` | `number | string` |  |  |
| `flexDirection` | `FlexDirectionString` |  |  |
| `flexGrow` | `number` |  |  |
| `flexShrink` | `number` |  |  |
| `focusedBackgroundColor` | `ColorInput` |  |  |
| `focusedTextColor` | `ColorInput` |  |  |
| `height` | `number` |  |  |
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
| `options` | `array` |  |  |
| `padding` | `number | string` |  |  |
| `paddingBottom` | `number | string` |  |  |
| `paddingLeft` | `number | string` |  |  |
| `paddingRight` | `number | string` |  |  |
| `paddingTop` | `number | string` |  |  |
| `position` | `PositionTypeString` |  |  |
| `right` | `number | string | string` |  |  |
| `selectedBackgroundColor` | `ColorInput` |  |  |
| `selectedDescriptionColor` | `ColorInput` |  |  |
| `selectedTextColor` | `ColorInput` |  |  |
| `showDescription` | `boolean` |  |  |
| `showScrollArrows` | `boolean` |  |  |
| `showUnderline` | `boolean` |  |  |
| `tabWidth` | `number` |  |  |
| `textColor` | `ColorInput` |  |  |
| `top` | `number | string | string` |  |  |
| `visible` | `boolean` |  |  |
| `width` | `number | string | string` |  |  |
| `wrapSelection` | `boolean` |  |  |
| `zIndex` | `number` |  |  |

## Example

```typescript
const options: TabSelectRenderableOptions = {

};
```

## Related Types

- `AlignString`
- `ColorInput`
- `FlexDirectionString`
- `JustifyString`
- `MouseEvent`
- `MouseEventType`
- `ParsedKey`
- `PositionTypeString`
- `RGBA`
- `Renderable`
- `ScrollInfo`
- `TabSelectOption`
