# Animation

> **Quick Navigation:** [Getting Started](./getting-started.md) | [Components](./components.md) | [Layout](./layout.md) | [Events](./events.md) | [Rendering](./rendering.md)

OpenTUI provides a powerful animation system for creating smooth transitions and effects.

## Timeline Animations

```typescript
import { Timeline, Easing } from '@opentui/core';

// Create a timeline
const timeline = new Timeline({
  duration: 2000,
  loop: true,
  autoplay: true
});

// Add animations
timeline.add({
  target: myBox,
  properties: {
    x: { from: 0, to: 100 },
    y: { from: 0, to: 50 },
    opacity: { from: 0, to: 1 }
  },
  duration: 1000,
  easing: Easing.easeInOutQuad,
  delay: 0
});

// Chain animations
timeline
  .add({
    target: box1,
    properties: { x: { to: 100 } },
    duration: 500
  })
  .add({
    target: box2,
    properties: { y: { to: 50 } },
    duration: 500,
    offset: '-=250' // Start 250ms before previous ends
  });

// Control playback
timeline.play();
timeline.pause();
timeline.stop();
timeline.seek(500); // Jump to 500ms
```

## Property Animations

```typescript
class AnimatedBox extends BoxRenderable {
  private animator = new PropertyAnimator(this);
  
  async slideIn() {
    await this.animator.animate({
      x: { from: -this.width, to: 0 },
      opacity: { from: 0, to: 1 }
    }, {
      duration: 300,
      easing: 'easeOutQuad'
    });
  }
  
  async slideOut() {
    await this.animator.animate({
      x: { to: this.parent.width },
      opacity: { to: 0 }
    }, {
      duration: 300,
      easing: 'easeInQuad'
    });
  }
  
  pulse() {
    this.animator.animate({
      scale: { from: 1, to: 1.1, to: 1 }
    }, {
      duration: 200,
      repeat: 3
    });
  }
}
```

## Easing Functions

Built-in easing functions:
- Linear: `linear`
- Quad: `easeInQuad`, `easeOutQuad`, `easeInOutQuad`
- Cubic: `easeInCubic`, `easeOutCubic`, `easeInOutCubic`
- Expo: `easeInExpo`, `easeOutExpo`, `easeInOutExpo`
- Bounce: `easeInBounce`, `easeOutBounce`, `easeInOutBounce`
- Elastic: `easeInElastic`, `easeOutElastic`, `easeInOutElastic`
- Back: `easeInBack`, `easeOutBack`, `easeInOutBack`

```typescript
// Custom easing function
function customEase(t: number): number {
  // t is 0 to 1
  return t * t * (3 - 2 * t); // Smooth step
}

timeline.add({
  target: component,
  properties: { x: { to: 100 } },
  easing: customEase
});
```

## Frame-based Animation

```typescript
class ParticleEffect extends Renderable {
  private particles: Particle[] = [];
  
  protected renderSelf(buffer: OptimizedBuffer, deltaTime: number): void {
    // Update particles
    this.particles.forEach(particle => {
      particle.x += particle.vx * deltaTime;
      particle.y += particle.vy * deltaTime;
      particle.vy += 0.1 * deltaTime; // Gravity
      particle.life -= deltaTime;
      
      if (particle.life > 0) {
        const opacity = particle.life / particle.maxLife;
        buffer.setCell(
          Math.round(particle.x),
          Math.round(particle.y),
          '•',
          RGBA.fromValues(1, 1, 1, opacity)
        );
      }
    });
    
    // Remove dead particles
    this.particles = this.particles.filter(p => p.life > 0);
    
    // Keep animating if particles exist
    if (this.particles.length > 0) {
      this.needsUpdate();
    }
  }
  
  emit(x: number, y: number, count: number) {
    for (let i = 0; i < count; i++) {
      this.particles.push({
        x, y,
        vx: (Math.random() - 0.5) * 10,
        vy: Math.random() * -10,
        life: 1000,
        maxLife: 1000
      });
    }
    this.needsUpdate();
  }
}
```

## Transition Effects

```typescript
class TransitionManager {
  async fadeTransition(from: Renderable, to: Renderable, duration = 500) {
    to.style.opacity = 0;
    to.visible = true;
    
    const timeline = new Timeline({ duration });
    
    timeline.add({
      target: from,
      properties: { opacity: { to: 0 } },
      duration: duration / 2
    });
    
    timeline.add({
      target: to,
      properties: { opacity: { to: 1 } },
      duration: duration / 2,
      offset: `-=${duration/4}` // Overlap
    });
    
    await timeline.play();
    from.visible = false;
  }
  
  async slideTransition(from: Renderable, to: Renderable, direction = 'left') {
    const parent = from.parent;
    const width = parent.computedWidth;
    
    // Position 'to' off-screen
    if (direction === 'left') {
      to.x = width;
    } else {
      to.x = -width;
    }
    to.visible = true;
    
    const timeline = new Timeline({ duration: 300 });
    
    timeline.add({
      targets: [from, to],
      properties: {
        x: {
          from: (target) => target.x,
          to: (target) => {
            if (target === from) {
              return direction === 'left' ? -width : width;
            } else {
              return 0;
            }
          }
        }
      },
      easing: 'easeInOutQuad'
    });
    
    await timeline.play();
    from.visible = false;
  }
}
```

## Sprite Animations

```typescript
class SpriteAnimation extends Renderable {
  private frames: string[] = [];
  private currentFrame = 0;
  private frameDuration = 100;
  private elapsed = 0;
  
  constructor(id: string, frames: string[]) {
    super(id, {});
    this.frames = frames;
  }
  
  protected renderSelf(buffer: OptimizedBuffer, deltaTime: number): void {
    // Update animation
    this.elapsed += deltaTime;
    if (this.elapsed >= this.frameDuration) {
      this.currentFrame = (this.currentFrame + 1) % this.frames.length;
      this.elapsed = 0;
    }
    
    // Draw current frame
    const frame = this.frames[this.currentFrame];
    const lines = frame.split('\n');
    lines.forEach((line, y) => {
      buffer.drawText(line, this.x, this.y + y);
    });
    
    this.needsUpdate(); // Continue animating
  }
}

// ASCII spinner animation
const spinner = new SpriteAnimation('spinner', [
  '⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'
]);
```

## Performance Best Practices

### Optimize Animation Updates

```typescript
class OptimizedAnimation extends Renderable {
  private isDirty = false;
  private animationFrame = 0;
  private targetFPS = 30;
  private frameInterval = 1000 / 30; // 33ms per frame
  private lastFrame = 0;
  
  protected renderSelf(buffer: OptimizedBuffer, deltaTime: number): void {
    // Throttle animation to target FPS
    this.lastFrame += deltaTime;
    if (this.lastFrame < this.frameInterval) {
      this.needsUpdate();
      return;
    }
    
    // Only update if changed
    if (this.isDirty) {
      this.updateAnimation();
      this.isDirty = false;
    }
    
    // Continue if animating
    if (this.isAnimating) {
      this.needsUpdate();
    }
    
    this.lastFrame = 0;
  }
}
```

### Batch Animations

```typescript
class AnimationBatcher {
  private animations: Map<Renderable, AnimationConfig> = new Map();
  private timeline: Timeline;
  
  batchAnimate(targets: Renderable[], config: AnimationConfig) {
    // Batch multiple targets in single timeline
    this.timeline = new Timeline({ duration: config.duration });
    
    targets.forEach((target, index) => {
      this.timeline.add({
        target,
        properties: config.properties,
        duration: config.duration,
        easing: config.easing,
        // Stagger animations
        delay: config.stagger ? index * config.stagger : 0
      });
    });
    
    return this.timeline.play();
  }
}

// Usage
const batcher = new AnimationBatcher();
const boxes = [box1, box2, box3, box4];

await batcher.batchAnimate(boxes, {
  properties: {
    y: { to: 10 },
    opacity: { from: 0, to: 1 }
  },
  duration: 500,
  stagger: 50, // 50ms delay between each
  easing: 'easeOutQuad'
});
```

## Complex Animation Examples

### Loading Bar Animation

```typescript
class LoadingBar extends BoxRenderable {
  private progress = 0;
  private targetProgress = 0;
  private animating = false;
  
  constructor(id: string, options: BoxOptions) {
    super(id, {
      ...options,
      height: 3,
      border: true,
      borderStyle: 'single'
    });
  }
  
  setProgress(value: number) {
    this.targetProgress = Math.max(0, Math.min(100, value));
    if (!this.animating) {
      this.animateProgress();
    }
  }
  
  private async animateProgress() {
    this.animating = true;
    
    while (Math.abs(this.progress - this.targetProgress) > 0.1) {
      // Smooth interpolation
      this.progress += (this.targetProgress - this.progress) * 0.1;
      this.needsUpdate();
      await new Promise(resolve => setTimeout(resolve, 16));
    }
    
    this.progress = this.targetProgress;
    this.animating = false;
    this.needsUpdate();
  }
  
  protected renderSelf(buffer: OptimizedBuffer, deltaTime: number): void {
    super.renderSelf(buffer, deltaTime);
    
    const innerWidth = this.computedWidth - 2;
    const filled = Math.floor(innerWidth * (this.progress / 100));
    
    // Draw progress bar
    for (let x = 0; x < filled; x++) {
      buffer.setCell(
        this.x + 1 + x,
        this.y + 1,
        '█',
        RGBA.fromHex('#00ff00')
      );
    }
    
    // Draw percentage
    const text = `${Math.round(this.progress)}%`;
    buffer.drawText(
      text,
      this.x + Math.floor(innerWidth / 2) - Math.floor(text.length / 2),
      this.y + 1,
      RGBA.fromHex('#ffffff')
    );
  }
}
```

### Notification Toast Animation

```typescript
class Toast extends BoxRenderable {
  private timeline: Timeline;
  
  constructor(message: string, type: 'success' | 'error' | 'info' = 'info') {
    const colors = {
      success: '#00ff00',
      error: '#ff0000',
      info: '#00aaff'
    };
    
    super('toast', {
      width: message.length + 4,
      height: 3,
      border: true,
      borderStyle: 'rounded',
      borderColor: colors[type],
      backgroundColor: '#1e1e1e',
      padding: { left: 1, right: 1 },
      position: 'absolute',
      right: 2,
      top: -5, // Start off-screen
      zIndex: 1000
    });
    
    const text = new TextRenderable('message', {
      text: message,
      color: colors[type]
    });
    this.add(text, 0);
  }
  
  async show(duration = 3000) {
    this.timeline = new Timeline({ duration: duration + 600 });
    
    // Slide in
    this.timeline.add({
      target: this,
      properties: {
        top: { from: -5, to: 2 }
      },
      duration: 300,
      easing: 'easeOutBack'
    });
    
    // Wait
    this.timeline.add({
      target: this,
      properties: {}, // No-op
      duration: duration
    });
    
    // Slide out
    this.timeline.add({
      target: this,
      properties: {
        top: { to: -5 },
        opacity: { to: 0 }
      },
      duration: 300,
      easing: 'easeInBack'
    });
    
    await this.timeline.play();
    this.destroy();
  }
}

// Usage
const toast = new Toast('File saved successfully!', 'success');
renderer.root.add(toast, 999);
await toast.show();
```

### Wave Animation Effect

```typescript
class WaveText extends Renderable {
  private text: string;
  private amplitude = 2;
  private frequency = 0.5;
  private phase = 0;
  
  constructor(id: string, text: string) {
    super(id, { width: text.length, height: 5 });
    this.text = text;
  }
  
  protected renderSelf(buffer: OptimizedBuffer, deltaTime: number): void {
    // Update wave phase
    this.phase += deltaTime * 0.003;
    
    // Draw each character with wave offset
    for (let i = 0; i < this.text.length; i++) {
      const yOffset = Math.sin(this.phase + i * this.frequency) * this.amplitude;
      const y = Math.round(this.y + 2 + yOffset);
      
      // Color based on height
      const hue = (i * 30 + this.phase * 100) % 360;
      const color = RGBA.fromHSL(hue, 100, 50);
      
      buffer.setCell(
        this.x + i,
        y,
        this.text[i],
        color
      );
    }
    
    this.needsUpdate(); // Continue animating
  }
}
```

## Animation Sequencing

```typescript
class AnimationSequence {
  private steps: (() => Promise<void>)[] = [];
  
  add(step: () => Promise<void>): this {
    this.steps.push(step);
    return this;
  }
  
  async play() {
    for (const step of this.steps) {
      await step();
    }
  }
  
  async playParallel() {
    await Promise.all(this.steps.map(step => step()));
  }
}

// Complex animation sequence
const sequence = new AnimationSequence();

sequence
  .add(async () => {
    // Fade in title
    await titleBox.animate({ opacity: { from: 0, to: 1 } }, 500);
  })
  .add(async () => {
    // Slide in menu items
    const items = [item1, item2, item3];
    for (let i = 0; i < items.length; i++) {
      await items[i].animate({
        x: { from: -20, to: 0 },
        opacity: { from: 0, to: 1 }
      }, 200);
    }
  })
  .add(async () => {
    // Show content with bounce
    await content.animate({
      scale: { from: 0, to: 1.1, to: 1 },
      opacity: { from: 0, to: 1 }
    }, {
      duration: 400,
      easing: 'easeOutBounce'
    });
  });

await sequence.play();
```

## Troubleshooting

### Common Issues

1. **Choppy animations**: Reduce animation complexity or decrease target FPS
2. **Memory leaks**: Always stop/destroy timelines when components unmount
3. **CPU usage**: Use `requestAnimationFrame` pattern or throttle updates
4. **Flickering**: Enable double buffering with `buffered: true`

### Debug Animation Performance

```typescript
class AnimationDebugger {
  private frameCount = 0;
  private lastFPSUpdate = Date.now();
  private currentFPS = 0;
  
  measureFrame(callback: () => void) {
    const start = performance.now();
    callback();
    const duration = performance.now() - start;
    
    this.frameCount++;
    const now = Date.now();
    if (now - this.lastFPSUpdate > 1000) {
      this.currentFPS = this.frameCount;
      this.frameCount = 0;
      this.lastFPSUpdate = now;
      
      console.log(`FPS: ${this.currentFPS}, Frame time: ${duration.toFixed(2)}ms`);
    }
  }
}
```

## Related Topics

### Components & Animation
- [Components: Custom](./components.md#custom-components) - Building animated components
- [Components: ASCII Font](./components.md#ascii-font-component) - Animated text effects
- [Getting Started](./getting-started.md) - Animation basics

### User Interaction
- [Events: Mouse](./events.md#mouse-events) - Trigger animations on interaction
- [Events: Keyboard](./events.md#keyboard-events) - Keyboard-triggered animations
- [Events: Forms](./events.md#form-handling) - Form validation animations

### Layout Animation
- [Layout: Flexbox](./layout.md#flexbox-properties) - Animating layout properties
- [Layout: Responsive](./layout.md#responsive-techniques) - Smooth responsive transitions
- [Layout: Scrollable](./layout.md#scrollable-content) - Animated scrolling

### Performance
- [Rendering: Optimization](./rendering.md#performance-monitoring) - Animation performance
- [Rendering: Frame Time](./rendering.md#frame-time-analysis) - Measuring animation FPS
- [Rendering: Techniques](./rendering.md#advanced-rendering-techniques) - Visual effects

## Animation Patterns

### Common Animations
- **Loading:** Progress bars, spinners (see examples above)
- **Notifications:** [Toast animations](#notification-toast-animation)
- **Transitions:** Page changes, modal appearances
- **Feedback:** Button presses, hover effects

### Combining with Events
Create interactive animations:
- [Events: Mouse](./events.md#mouse-events) - Hover and click animations
- [Events: Focus](./events.md#focus-management) - Focus state animations
- [Components: Input](./components.md#input-component) - Input validation animations

### Performance Optimization
- Use [Rendering: Optimization](./rendering.md#render-optimization-strategies) techniques
- Implement frame throttling (see examples above)
- Cache complex animations with [Rendering: Caching](./rendering.md#caching-complex-renders)

## Next Steps

- **Add Interaction:** Trigger animations with [Events](./events.md)
- **Build Components:** Create animated [Components](./components.md)
- **Optimize:** Improve performance with [Rendering](./rendering.md) techniques
- **Layout:** Animate [Layout](./layout.md) changes smoothly
