# ExplosionEffectParameters

## Properties

| Property | Type | Required | Description |
|----------|------|----------|-------------|
| `angularVelocityMax` | `Vector3` | ✓ |  |
| `angularVelocityMin` | `Vector3` | ✓ |  |
| `durationMs` | `number` | ✓ |  |
| `fadeOut` | `boolean` | ✓ |  |
| `gravity` | `number` | ✓ |  |
| `gravityScale` | `number` | ✓ |  |
| `initialVelocityYBoost` | `number` | ✓ |  |
| `materialFactory` | `any` | ✓ | () => NodeMaterial |
| `numCols` | `number` | ✓ |  |
| `numRows` | `number` | ✓ |  |
| `strength` | `number` | ✓ |  |
| `strengthVariation` | `number` | ✓ |  |
| `zVariationStrength` | `number` | ✓ |  |

## Example

```typescript
const options: ExplosionEffectParameters = {
  angularVelocityMax: undefined,
  angularVelocityMin: undefined,
  durationMs: 0,
  fadeOut: false,
  gravity: 0
};
```

## Related Types

- `Vector3`
