# Timeline

Animation timeline system for orchestrating complex animations and transitions.

## Constructor

```typescript
new Timeline(options: TimelineOptions)
```

### Parameters

#### options

Type: `TimelineOptions`

Available options:

| Property | Type | Required | Description |
|----------|------|----------|-------------|
| `autoplay` | `boolean` |  |  |
| `duration` | `number` |  |  |
| `loop` | `boolean` |  |  |
| `onComplete` | `any` |  | () => void |
| `onPause` | `any` |  | () => void |

## Properties

### items

Type: `(TimelineAnimationItem | TimelineCallbackItem)[]`

### subTimelines

Type: `TimelineTimelineItem[]`

### currentTime

Type: `number`

Current playback position

### isPlaying

Type: `boolean`

Whether the timeline is currently playing

### isComplete

Type: `boolean`

### duration

Type: `number`

Total duration of the timeline in milliseconds

### loop

Type: `boolean`

Whether to loop when reaching the end

### synced

Type: `boolean`

## Methods

### add()

Add an animation to the timeline

#### Signature

```typescript
add(target: any, properties: AnimationOptions, startTime: number | string): this
```

#### Parameters

- **target**: `any`
- **properties**: `AnimationOptions`
- **startTime**: `number | string`

#### Returns

`this`

### once()

#### Signature

```typescript
once(target: any, properties: AnimationOptions): this
```

#### Parameters

- **target**: `any`
- **properties**: `AnimationOptions`

#### Returns

`this`

### call()

#### Signature

```typescript
call(callback: () => void, startTime: number | string): this
```

#### Parameters

- **callback**: `() => void`
- **startTime**: `number | string`

#### Returns

`this`

### sync()

#### Signature

```typescript
sync(timeline: Timeline, startTime: number): this
```

#### Parameters

- **timeline**: `Timeline`
- **startTime**: `number`

#### Returns

`this`

### play()

Start or resume playback

#### Signature

```typescript
play(): this
```

#### Returns

`this`

### pause()

Pause playback

#### Signature

```typescript
pause(): this
```

#### Returns

`this`

### resetItems()

#### Signature

```typescript
resetItems(): void
```

### restart()

#### Signature

```typescript
restart(): this
```

#### Returns

`this`

### update()

#### Signature

```typescript
update(deltaTime: number): void
```

#### Parameters

- **deltaTime**: `number`

## Examples

```typescript
// Create animation timeline
const timeline = new Timeline({
  duration: 2000,
  loop: true,
  autoplay: true
});

// Add animations
timeline.add({
  target: myComponent,
  properties: {
    x: { from: 0, to: 100 },
    opacity: { from: 0, to: 1 }
  },
  duration: 1000,
  easing: 'easeInOutQuad'
});
```

## See Also

