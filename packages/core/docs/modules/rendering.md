# Rendering System

> **Quick Navigation:** [Getting Started](./getting-started.md) | [Components](./components.md) | [Layout](./layout.md) | [Events](./events.md) | [Animation](./animation.md)

Understanding how OpenTUI renders to the terminal for optimal performance.

## Render Pipeline

```
Input Events → Layout → Component Render → Buffer Diff → Terminal Update
```

## The OptimizedBuffer

OpenTUI uses a double-buffered rendering system with dirty region tracking.

```typescript
import { OptimizedBuffer, RGBA } from '@opentui/core';

class CustomRenderer extends Renderable {
  protected renderSelf(buffer: OptimizedBuffer, deltaTime: number): void {
    // Clear a region
    buffer.clear(this.x, this.y, this.width, this.height);
    
    // Draw text
    buffer.drawText(
      'Hello World',
      this.x, 
      this.y,
      RGBA.fromHex('#ffffff'),  // Foreground
      RGBA.fromHex('#000000')   // Background
    );
    
    // Draw individual cells
    for (let x = 0; x < this.width; x++) {
      buffer.setCell(
        this.x + x,
        this.y + 1,
        '═',
        RGBA.white(),
        RGBA.black()
      );
    }
    
    // Draw a box
    buffer.drawBox(
      this.x,
      this.y,
      this.width,
      this.height,
      {
        style: 'double',
        color: RGBA.fromHex('#00ff00')
      }
    );
  }
}
```

## Color Management

```typescript
import { RGBA } from '@opentui/core';

// Create colors
const red = RGBA.fromHex('#ff0000');
const green = RGBA.fromValues(0, 1, 0, 1); // r, g, b, a (0-1)
const blue = new RGBA(0, 0, 255, 255); // r, g, b, a (0-255)

// Color with transparency
const semiTransparent = RGBA.fromValues(1, 1, 1, 0.5);

// Blend colors
const purple = RGBA.blend(red, blue, 0.5);

// Common colors
const white = RGBA.white();
const black = RGBA.black();
const transparent = RGBA.transparent();
```

## Dirty Region Optimization

```typescript
class OptimizedComponent extends Renderable {
  private isDirty = true;
  
  protected renderSelf(buffer: OptimizedBuffer, deltaTime: number): void {
    if (!this.isDirty) {
      return; // Skip rendering if not dirty
    }
    
    // Mark the region we're about to render as dirty
    buffer.markDirty(this.x, this.y, this.width, this.height);
    
    // Render content
    this.renderContent(buffer);
    
    this.isDirty = false;
  }
  
  // Call when content changes
  invalidate() {
    this.isDirty = true;
    this.needsUpdate(); // Request re-render
  }
}
```

## Layered Rendering

```typescript
class LayeredUI extends Renderable {
  private layers: Map<number, Renderable[]> = new Map();
  
  addToLayer(component: Renderable, layer: number) {
    if (!this.layers.has(layer)) {
      this.layers.set(layer, []);
    }
    this.layers.get(layer)!.push(component);
    component.zIndex = layer;
  }
  
  protected renderSelf(buffer: OptimizedBuffer, deltaTime: number): void {
    // Render layers in order
    const sortedLayers = Array.from(this.layers.keys()).sort();
    
    for (const layer of sortedLayers) {
      const components = this.layers.get(layer)!;
      for (const component of components) {
        component.render(buffer, deltaTime);
      }
    }
  }
}
```

## Performance Tips

### 1. Use Buffered Rendering

```typescript
// Good - renders to internal buffer first
const buffered = new BoxRenderable('buffered', {
  buffered: true, // Enable internal buffering
  width: 100,
  height: 50
});

// Updates only re-render this component, not parents
buffered.needsUpdate();
```

### 2. Batch Updates

```typescript
class BatchUpdater extends Renderable {
  private pendingUpdates: Function[] = [];
  
  queueUpdate(fn: Function) {
    this.pendingUpdates.push(fn);
  }
  
  flushUpdates() {
    // Batch all updates together
    this.pendingUpdates.forEach(fn => fn());
    this.pendingUpdates = [];
    this.needsUpdate(); // Single re-render
  }
}
```

### 3. Virtual Scrolling

```typescript
class VirtualList extends Renderable {
  private items: string[] = [];
  private scrollOffset = 0;
  private itemHeight = 1;
  
  protected renderSelf(buffer: OptimizedBuffer, deltaTime: number): void {
    const visibleItems = Math.floor(this.height / this.itemHeight);
    const startIndex = this.scrollOffset;
    const endIndex = Math.min(startIndex + visibleItems, this.items.length);
    
    // Only render visible items
    for (let i = startIndex; i < endIndex; i++) {
      const y = this.y + (i - startIndex) * this.itemHeight;
      buffer.drawText(this.items[i], this.x, y);
    }
  }
}
```

### 4. Caching Complex Renders

```typescript
class CachedComponent extends Renderable {
  private cache?: OptimizedBuffer;
  private cacheValid = false;
  
  protected renderSelf(buffer: OptimizedBuffer, deltaTime: number): void {
    if (!this.cacheValid) {
      // Render to cache
      this.cache = OptimizedBuffer.create(this.width, this.height);
      this.renderToCache(this.cache);
      this.cacheValid = true;
    }
    
    // Copy from cache
    buffer.copyFrom(this.cache, this.x, this.y);
  }
  
  invalidateCache() {
    this.cacheValid = false;
    this.needsUpdate();
  }
}
```

## Debug Overlay

```typescript
// Enable debug overlay
renderer.toggleDebugOverlay();

// Configure overlay
renderer.configureDebugOverlay({
  enabled: true,
  corner: DebugOverlayCorner.TOP_RIGHT,
  showFPS: true,
  showDirtyRegions: true,
  showLayoutBounds: true
});
```

## Advanced Rendering Techniques

### Custom Cell Rendering

```typescript
class MatrixRain extends Renderable {
  private columns: number[] = [];
  private chars = 'ﾊﾐﾋｰｳｼﾅﾓﾆｻﾜﾂｵﾘｱﾎﾃﾏｹﾒｴｶｷﾑﾕﾗｾﾈｽﾀﾇﾍ0123456789';
  
  constructor(id: string, options: RenderableOptions) {
    super(id, options);
    this.columns = new Array(this.width).fill(0);
  }
  
  protected renderSelf(buffer: OptimizedBuffer, deltaTime: number): void {
    // Fade existing cells
    for (let y = 0; y < this.height; y++) {
      for (let x = 0; x < this.width; x++) {
        const cell = buffer.getCell(this.x + x, this.y + y);
        if (cell) {
          // Fade to black
          const color = cell.fg;
          const faded = RGBA.fromValues(
            0,
            color.g * 0.9,
            0,
            color.a * 0.95
          );
          buffer.setCell(
            this.x + x,
            this.y + y,
            cell.char,
            faded
          );
        }
      }
    }
    
    // Update columns
    for (let x = 0; x < this.columns.length; x++) {
      if (Math.random() > 0.98) {
        this.columns[x] = 0; // Reset column
      }
      
      const y = this.columns[x];
      if (y < this.height) {
        const char = this.chars[Math.floor(Math.random() * this.chars.length)];
        const brightness = y === 0 ? 1 : 0.7;
        
        buffer.setCell(
          this.x + x,
          this.y + y,
          char,
          RGBA.fromValues(0, brightness, 0, 1)
        );
        
        this.columns[x]++;
      }
    }
    
    this.needsUpdate();
  }
}
```

### Gradient Rendering

```typescript
class GradientBox extends BoxRenderable {
  private gradient: {
    startColor: RGBA;
    endColor: RGBA;
    direction: 'horizontal' | 'vertical' | 'diagonal';
  };
  
  protected renderSelf(buffer: OptimizedBuffer, deltaTime: number): void {
    super.renderSelf(buffer, deltaTime);
    
    const { startColor, endColor, direction } = this.gradient;
    
    for (let y = 0; y < this.height; y++) {
      for (let x = 0; x < this.width; x++) {
        let progress: number;
        
        switch (direction) {
          case 'horizontal':
            progress = x / this.width;
            break;
          case 'vertical':
            progress = y / this.height;
            break;
          case 'diagonal':
            progress = (x + y) / (this.width + this.height);
            break;
        }
        
        const color = RGBA.blend(startColor, endColor, progress);
        buffer.setCell(
          this.x + x,
          this.y + y,
          ' ',
          color,
          color // Use as background
        );
      }
    }
  }
}
```

### Shadow Effects

```typescript
class ShadowBox extends BoxRenderable {
  private shadowOffset = { x: 2, y: 1 };
  private shadowColor = RGBA.fromValues(0, 0, 0, 0.5);
  
  protected renderSelf(buffer: OptimizedBuffer, deltaTime: number): void {
    // Draw shadow first
    for (let y = 0; y < this.height; y++) {
      for (let x = 0; x < this.width; x++) {
        const shadowX = this.x + x + this.shadowOffset.x;
        const shadowY = this.y + y + this.shadowOffset.y;
        
        // Blend shadow with existing content
        const existing = buffer.getCell(shadowX, shadowY);
        if (existing) {
          const blended = RGBA.blend(existing.bg, this.shadowColor, 0.5);
          buffer.setCell(shadowX, shadowY, existing.char, existing.fg, blended);
        }
      }
    }
    
    // Draw box on top
    super.renderSelf(buffer, deltaTime);
  }
}
```

### Texture Patterns

```typescript
class TexturedBackground extends Renderable {
  private patterns = {
    dots: ['·', '•', '●'],
    lines: ['─', '═', '━'],
    crosses: ['┼', '╬', '╋'],
    blocks: ['░', '▒', '▓']
  };
  
  renderPattern(
    buffer: OptimizedBuffer,
    pattern: keyof typeof this.patterns,
    density: number = 0.3
  ) {
    const chars = this.patterns[pattern];
    
    for (let y = 0; y < this.height; y++) {
      for (let x = 0; x < this.width; x++) {
        if (Math.random() < density) {
          const char = chars[Math.floor(Math.random() * chars.length)];
          const brightness = 0.2 + Math.random() * 0.3;
          
          buffer.setCell(
            this.x + x,
            this.y + y,
            char,
            RGBA.fromValues(brightness, brightness, brightness, 1)
          );
        }
      }
    }
  }
}
```

## Performance Monitoring

### Frame Time Analysis

```typescript
class RenderProfiler {
  private samples: number[] = [];
  private maxSamples = 100;
  
  startFrame(): () => void {
    const start = performance.now();
    
    return () => {
      const duration = performance.now() - start;
      this.samples.push(duration);
      
      if (this.samples.length > this.maxSamples) {
        this.samples.shift();
      }
    };
  }
  
  getStats() {
    if (this.samples.length === 0) return null;
    
    const sorted = [...this.samples].sort((a, b) => a - b);
    const sum = sorted.reduce((a, b) => a + b, 0);
    
    return {
      avg: sum / sorted.length,
      min: sorted[0],
      max: sorted[sorted.length - 1],
      p50: sorted[Math.floor(sorted.length * 0.5)],
      p95: sorted[Math.floor(sorted.length * 0.95)],
      p99: sorted[Math.floor(sorted.length * 0.99)]
    };
  }
}

// Usage
const profiler = new RenderProfiler();

class ProfiledComponent extends Renderable {
  protected renderSelf(buffer: OptimizedBuffer, deltaTime: number): void {
    const endProfile = profiler.startFrame();
    
    // Render logic here
    this.renderContent(buffer);
    
    endProfile();
    
    // Log stats periodically
    if (Math.random() < 0.01) {
      console.log('Render stats:', profiler.getStats());
    }
  }
}
```

### Memory Usage Tracking

```typescript
class MemoryMonitor {
  private buffers = new WeakMap<OptimizedBuffer, number>();
  
  trackBuffer(buffer: OptimizedBuffer) {
    const size = buffer.width * buffer.height * 4 * 2; // cells × RGBA × 2 (fg+bg)
    this.buffers.set(buffer, size);
  }
  
  getEstimatedMemory(): string {
    // Note: WeakMap doesn't allow iteration
    // This would need a different approach in production
    const usage = process.memoryUsage();
    return `Heap: ${(usage.heapUsed / 1024 / 1024).toFixed(2)}MB`;
  }
}
```

## Render Optimization Strategies

### 1. Scissor Regions

```typescript
class ScissoredRenderer extends Renderable {
  protected renderSelf(buffer: OptimizedBuffer, deltaTime: number): void {
    // Set scissor region to limit rendering
    buffer.setScissor(this.x, this.y, this.width, this.height);
    
    // All rendering operations are now clipped to this region
    this.renderChildren(buffer, deltaTime);
    
    // Clear scissor
    buffer.clearScissor();
  }
}
```

### 2. Level of Detail (LOD)

```typescript
class LODComponent extends Renderable {
  private distanceFromFocus: number = 0;
  
  protected renderSelf(buffer: OptimizedBuffer, deltaTime: number): void {
    if (this.distanceFromFocus > 100) {
      // Far away - render simplified version
      this.renderLowDetail(buffer);
    } else if (this.distanceFromFocus > 50) {
      // Medium distance - render medium detail
      this.renderMediumDetail(buffer);
    } else {
      // Close - render full detail
      this.renderHighDetail(buffer);
    }
  }
  
  private renderLowDetail(buffer: OptimizedBuffer) {
    // Just a colored block
    buffer.fillRect(this.x, this.y, this.width, this.height, '█');
  }
  
  private renderMediumDetail(buffer: OptimizedBuffer) {
    // Basic box with title
    buffer.drawBox(this.x, this.y, this.width, this.height);
    buffer.drawText(this.title, this.x + 1, this.y);
  }
  
  private renderHighDetail(buffer: OptimizedBuffer) {
    // Full rendering with all details
    super.renderSelf(buffer, deltaTime);
  }
}
```

### 3. Render Culling

```typescript
class CullingRenderer extends CliRenderer {
  private viewport = { x: 0, y: 0, width: 80, height: 24 };
  
  protected renderTree(buffer: OptimizedBuffer, deltaTime: number) {
    this.cullAndRender(this.root, buffer, deltaTime);
  }
  
  private cullAndRender(
    node: Renderable,
    buffer: OptimizedBuffer,
    deltaTime: number
  ) {
    // Check if node is visible in viewport
    if (!this.isInViewport(node)) {
      return; // Skip rendering
    }
    
    // Render node
    node.render(buffer, deltaTime);
    
    // Recursively render visible children
    for (const child of node.getChildren()) {
      this.cullAndRender(child, buffer, deltaTime);
    }
  }
  
  private isInViewport(node: Renderable): boolean {
    return !(
      node.x + node.width < this.viewport.x ||
      node.y + node.height < this.viewport.y ||
      node.x > this.viewport.x + this.viewport.width ||
      node.y > this.viewport.y + this.viewport.height
    );
  }
}
```

## Troubleshooting Rendering Issues

### Common Problems and Solutions

1. **Flickering**
   - Enable double buffering: `buffered: true`
   - Reduce update frequency
   - Check for unnecessary re-renders

2. **Tearing**
   - Synchronize updates with vsync if available
   - Use atomic buffer swaps
   - Avoid partial updates during render

3. **Performance**
   - Profile with debug overlay
   - Implement dirty region tracking
   - Use virtual scrolling for lists
   - Cache complex renders

4. **Color Issues**
   - Check terminal color support
   - Use fallback colors for limited terminals
   - Test with different terminal emulators

### Debugging Tools

```typescript
class RenderDebugger {
  static highlightDirtyRegions(buffer: OptimizedBuffer) {
    const regions = buffer.getDirtyRegions();
    for (const region of regions) {
      // Draw red border around dirty regions
      buffer.drawBox(
        region.x,
        region.y,
        region.width,
        region.height,
        {
          style: 'single',
          color: RGBA.fromHex('#ff0000')
        }
      );
    }
  }
  
  static showRenderOrder(root: Renderable, buffer: OptimizedBuffer) {
    let order = 0;
    
    function traverse(node: Renderable) {
      // Draw render order number
      buffer.drawText(
        order.toString(),
        node.x,
        node.y,
        RGBA.fromHex('#ffff00')
      );
      order++;
      
      for (const child of node.getChildren()) {
        traverse(child);
      }
    }
    
    traverse(root);
  }
}
```

## Related Topics

### Components & Rendering
- [Components: Custom](./components.md#custom-components) - Custom component rendering
- [Components: Box](./components.md#box-component) - Container rendering
- [Getting Started](./getting-started.md#core-concepts) - Render loop basics

### Animation Integration
- [Animation: Performance](./animation.md#performance-best-practices) - Optimizing animated renders
- [Animation: Frame-based](./animation.md#frame-based-animation) - Frame-by-frame rendering
- [Animation: Effects](./animation.md#complex-animation-examples) - Visual effects rendering

### Layout & Rendering
- [Layout: Optimization](./layout.md#best-practices) - Layout performance
- [Layout: Scrollable](./layout.md#scrollable-content) - Virtual scrolling
- [Layout: Responsive](./layout.md#responsive-techniques) - Responsive rendering

### Event-driven Rendering
- [Events: Mouse](./events.md#mouse-events) - Render on interaction
- [Events: Window](./events.md#window-events) - Handle resize rendering
- [Events: Forms](./events.md#form-handling) - Input field rendering

## Rendering Patterns

### Common Techniques
- **Double Buffering:** Prevent flicker with buffered rendering
- **Dirty Regions:** Only update changed areas
- **Virtual Scrolling:** Render only visible items
- **Caching:** Store complex renders for reuse

### Visual Effects
Implement advanced effects:
- [Gradients](#gradient-rendering) - Color gradients
- [Shadows](#shadow-effects) - Drop shadows
- [Textures](#texture-patterns) - Background patterns
- [Matrix Rain](#custom-cell-rendering) - Custom effects

### Performance Strategies
- [LOD](#level-of-detail-lod) - Adjust detail by distance
- [Culling](#render-culling) - Skip off-screen elements
- [Batching](#performance-tips) - Batch render operations
- [Profiling](#performance-monitoring) - Measure and optimize

## Best Practices

1. **Use Buffering:** Enable `buffered: true` for frequently updating components
2. **Track Dirty Regions:** Only redraw changed areas
3. **Implement Virtual Scrolling:** For long lists
4. **Cache Complex Renders:** Store and reuse expensive renders
5. **Profile Performance:** Measure frame times and optimize bottlenecks

## Next Steps

- **Build UIs:** Create efficient [Components](./components.md)
- **Add Motion:** Optimize [Animations](./animation.md) for performance
- **Handle Input:** Render feedback for [Events](./events.md)
- **Layout:** Create performant [Layouts](./layout.md)
