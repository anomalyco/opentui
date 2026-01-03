# Renderable.class

## Properties

| Property | Type | Required | Description |
|----------|------|----------|-------------|
| `id` | `string` | ✓ |  |
| `num` | `number` | ✓ |  |
| `parent` | `Renderable | null` | ✓ |  |
| `selectable` | `boolean` | ✓ |  |

## Example

```typescript
const options: Renderable.class = {
  id: "example",
  num: 0,
  parent: undefined,
  selectable: false
};
```

