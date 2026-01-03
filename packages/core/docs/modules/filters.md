# Post-Processing Filters Module

The filters module provides real-time post-processing effects for terminal rendering, operating directly on OptimizedBuffer data structures for performance.

## Overview

Post-processing filters manipulate the rendered buffer's foreground/background colors and characters to create visual effects. All filters work with normalized color values (0.0-1.0) in Float32Array buffers.

## Static Filter Functions

### Scanlines

Apply retro CRT-style scanline effect:

```typescript
import { applyScanlines } from '@opentui/core/post/filters'

// Darken every 2nd row to 80% brightness
applyScanlines(buffer, 0.8, 2)

// Stronger effect with wider gaps
applyScanlines(buffer, 0.5, 3)
```

### Grayscale

Convert colors to grayscale using luminance calculation:

```typescript
import { applyGrayscale } from '@opentui/core/post/filters'

// Convert entire buffer to grayscale
applyGrayscale(buffer)
// Uses formula: 0.299*R + 0.587*G + 0.114*B
```

### Sepia

Apply vintage sepia tone effect:

```typescript
import { applySepia } from '@opentui/core/post/filters'

// Apply sepia tone transformation
applySepia(buffer)
// Uses standard sepia matrix transformation
```

### Invert

Invert all colors:

```typescript
import { applyInvert } from '@opentui/core/post/filters'

// Invert fg and bg colors
applyInvert(buffer)
// Each channel becomes 1.0 - original
```

### Noise

Add random noise for texture:

```typescript
import { applyNoise } from '@opentui/core/post/filters'

// Add subtle noise
applyNoise(buffer, 0.1)

// Heavy static effect
applyNoise(buffer, 0.3)
```

### Chromatic Aberration

Simulate lens distortion with color channel separation:

```typescript
import { applyChromaticAberration } from '@opentui/core/post/filters'

// Subtle aberration
applyChromaticAberration(buffer, 1)

// Strong RGB separation
applyChromaticAberration(buffer, 3)
```

### ASCII Art

Convert buffer to ASCII art based on brightness:

```typescript
import { applyAsciiArt } from '@opentui/core/post/filters'

// Default ramp: " .:-=+*#%@"
applyAsciiArt(buffer)

// Custom character ramp
applyAsciiArt(buffer, " ░▒▓█")
```

## Effect Classes

### DistortionEffect

Animated glitch/distortion effect with configurable parameters:

```typescript
import { DistortionEffect } from '@opentui/core/post/filters'

const distortion = new DistortionEffect({
  glitchChancePerSecond: 0.5,
  maxGlitchLines: 3,
  minGlitchDuration: 0.05,
  maxGlitchDuration: 0.2,
  maxShiftAmount: 10,
  shiftFlipRatio: 0.6,
  colorGlitchChance: 0.2
})

// Apply with delta time for animation
distortion.apply(buffer, deltaTime)
```

Glitch types:
- **shift**: Horizontal pixel shifting with wrap-around
- **flip**: Horizontal line mirroring
- **color**: Random color corruption

### VignetteEffect

Darken corners for cinematic framing:

```typescript
import { VignetteEffect } from '@opentui/core/post/filters'

const vignette = new VignetteEffect(0.5)

// Apply vignette
vignette.apply(buffer)

// Adjust strength dynamically
vignette.strength = 0.8
```

Features:
- Precomputed distance attenuation for performance
- Automatic recalculation on buffer resize
- Non-negative strength clamping

### BrightnessEffect

Adjust overall brightness:

```typescript
import { BrightnessEffect } from '@opentui/core/post/filters'

const brightness = new BrightnessEffect(1.0)

// Darken to 50%
brightness.brightness = 0.5
brightness.apply(buffer)

// Brighten by 20%
brightness.brightness = 1.2
brightness.apply(buffer)
```

### BlurEffect

Optimized separable box blur with character modification:

```typescript
import { BlurEffect } from '@opentui/core/post/filters'

const blur = new BlurEffect(2)

// Apply blur
blur.apply(buffer)

// Adjust radius
blur.radius = 3
```

Features:
- Sliding window optimization for O(n) complexity
- Separate horizontal/vertical passes
- Character ramp based on alpha: `[" ", "░", "▒", "▓", " "]`

### BloomEffect

Light bloom based on brightness threshold:

```typescript
import { BloomEffect } from '@opentui/core/post/filters'

const bloom = new BloomEffect(
  0.8,  // threshold (0-1)
  0.2,  // strength
  2     // radius in pixels
)

// Apply bloom to bright areas
bloom.apply(buffer)

// Adjust parameters
bloom.threshold = 0.7
bloom.strength = 0.3
bloom.radius = 3
```

Features:
- Luminance-based bright pixel detection
- Linear distance falloff
- Additive blending with clamping

## Performance Considerations

### Direct Buffer Manipulation

All filters operate directly on OptimizedBuffer's typed arrays:
- `buffer.buffers.fg` - Float32Array for foreground colors
- `buffer.buffers.bg` - Float32Array for background colors
- `buffer.buffers.char` - Uint32Array for characters
- `buffer.buffers.attributes` - Uint8Array for text attributes

### Optimization Techniques

1. **Precomputation**: VignetteEffect caches distance calculations
2. **Separable Filters**: BlurEffect uses two 1D passes instead of 2D
3. **Sliding Window**: Blur uses moving average for O(n) complexity
4. **In-place Operations**: Most filters modify buffers directly
5. **Early Exit**: Effects skip processing when parameters indicate no change

## Integration Example

```typescript
import { CliRenderer } from '@opentui/core'
import { 
  applyGrayscale,
  VignetteEffect,
  DistortionEffect 
} from '@opentui/core/post/filters'

const renderer = new CliRenderer()
const vignette = new VignetteEffect(0.5)
const distortion = new DistortionEffect()

let lastTime = Date.now()

function render() {
  const now = Date.now()
  const deltaTime = (now - lastTime) / 1000
  lastTime = now
  
  const buffer = renderer.getBuffer()
  
  // Apply effects in sequence
  applyGrayscale(buffer)
  vignette.apply(buffer)
  distortion.apply(buffer, deltaTime)
  
  renderer.render()
  requestAnimationFrame(render)
}
```

## API Reference

### Functions

- `applyScanlines(buffer: OptimizedBuffer, strength?: number, step?: number): void`
- `applyGrayscale(buffer: OptimizedBuffer): void`
- `applySepia(buffer: OptimizedBuffer): void`
- `applyInvert(buffer: OptimizedBuffer): void`
- `applyNoise(buffer: OptimizedBuffer, strength?: number): void`
- `applyChromaticAberration(buffer: OptimizedBuffer, strength?: number): void`
- `applyAsciiArt(buffer: OptimizedBuffer, ramp?: string): void`

### Classes

- `DistortionEffect` - Animated glitch effects
- `VignetteEffect` - Corner darkening
- `BrightnessEffect` - Brightness adjustment
- `BlurEffect` - Box blur with character modification
- `BloomEffect` - Light bloom for bright areas

## Related Modules

- [Buffer](./buffer.md) - OptimizedBuffer structure
- [Rendering](./rendering.md) - Core rendering pipeline
- [Animation](./animation.md) - Timeline for animating effects