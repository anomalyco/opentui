import { getTimelineEngine, type JSAnimation, Timeline } from "@opentui/core"
import { CliRenderer, createCliRenderer, TextRenderable, BoxRenderable, type KeyEvent } from "@opentui/core"
import { setupCommonDemoKeys } from "./lib/standalone-keys.js"

class TimelineExample {
  private _mainTimeline: Timeline
  private _subTimeline1: Timeline
  private _subTimeline2: Timeline
  private renderer: CliRenderer
  private readonly animationEngine: ReturnType<typeof getTimelineEngine>
  private boxObject!: BoxRenderable
  private alternatingObject!: BoxRenderable
  private parentContainer: BoxRenderable

  private statusLine1!: TextRenderable
  private statusLine2!: TextRenderable
  private statusLine3!: TextRenderable
  private statusLine4!: TextRenderable
  private statusLine5!: TextRenderable
  private statusLine6!: TextRenderable
  private statusLine7!: TextRenderable
  private statusLine8!: TextRenderable
  private statusLine9!: TextRenderable

  constructor(renderer: CliRenderer) {
    this.renderer = renderer
    this.animationEngine = getTimelineEngine(renderer)

    this._mainTimeline = new Timeline({
      duration: 10000,
      loop: true,
    })

    this._subTimeline1 = new Timeline({
      duration: 8000,
      autoplay: false,
    })

    this._subTimeline2 = new Timeline({
      duration: 6000,
      autoplay: false,
    })

    this.parentContainer = new BoxRenderable(renderer, {
      id: "timeline-container",
      zIndex: 10,
    })
    try {
      this.setupViews(renderer)
      this.setupAnimations()
      this._mainTimeline.sync(this._subTimeline1, 0)
      this._mainTimeline.sync(this._subTimeline2, 3000)
      this.animationEngine.register(this._mainTimeline)
    } catch (error) {
      try {
        this.parentContainer.destroyRecursively()
      } catch {}
      throw error
    }
  }

  private setupViews(renderer: CliRenderer): void {
    this.renderer.root.add(this.parentContainer)

    this.boxObject = new BoxRenderable(renderer, {
      id: "box-object",
      position: "absolute",
      left: 10,
      top: 8,
      width: 8,
      height: 4,
      backgroundColor: "#FF6B6B",
      zIndex: 1,
      borderStyle: "single",
      borderColor: "#FFFFFF",
      title: "Box",
      titleAlignment: "center",
    })
    this.parentContainer.add(this.boxObject)

    const colorObject = new BoxRenderable(renderer, {
      id: "color-object",
      position: "absolute",
      left: 25,
      top: 8,
      width: 12,
      height: 4,
      backgroundColor: "#FF0000",
      zIndex: 1,
      borderStyle: "single",
      borderColor: "#FFFFFF",
      title: "Color",
      titleAlignment: "center",
    })
    this.parentContainer.add(colorObject)

    const physicsObject = new BoxRenderable(renderer, {
      id: "physics-object",
      position: "absolute",
      left: 45,
      top: 8,
      width: 12,
      height: 4,
      backgroundColor: "#4ECDC4",
      zIndex: 1,
      borderStyle: "single",
      borderColor: "#FFFFFF",
      title: "Physics",
      titleAlignment: "center",
    })
    this.parentContainer.add(physicsObject)

    this.alternatingObject = new BoxRenderable(renderer, {
      id: "alternating-object",
      position: "absolute",
      left: 1,
      top: 1,
      width: 8,
      height: 4,
      backgroundColor: "#9B59B6",
      zIndex: 1,
      borderStyle: "single",
      borderColor: "#FFFFFF",
      title: "Alternate",
      titleAlignment: "center",
    })
    this.parentContainer.add(this.alternatingObject)

    const mainTimelineBox = new BoxRenderable(renderer, {
      id: "main-timeline",
      position: "absolute",
      left: 2,
      top: 15,
      width: 60,
      height: 3,
      backgroundColor: "#333366",
      zIndex: 1,
      borderStyle: "single",
      borderColor: "#FFFFFF",
      title: "Main Timeline (20s)",
      titleAlignment: "left",
    })
    this.parentContainer.add(mainTimelineBox)

    const subTimeline1Box = new BoxRenderable(renderer, {
      id: "sub-timeline-1",
      position: "absolute",
      left: 2,
      top: 19,
      width: 30,
      height: 3,
      backgroundColor: "#333366",
      zIndex: 1,
      borderStyle: "single",
      borderColor: "#FFFFFF",
      title: "Sub Timeline 1 (8s)",
      titleAlignment: "left",
    })
    this.parentContainer.add(subTimeline1Box)

    const subTimeline2Box = new BoxRenderable(renderer, {
      id: "sub-timeline-2",
      position: "absolute",
      left: 35,
      top: 19,
      width: 27,
      height: 3,
      backgroundColor: "#333366",
      zIndex: 1,
      borderStyle: "single",
      borderColor: "#FFFFFF",
      title: "Sub Timeline 2 (6s)",
      titleAlignment: "left",
    })
    this.parentContainer.add(subTimeline2Box)

    const statusBox = new BoxRenderable(renderer, {
      id: "status",
      position: "absolute",
      left: 2,
      top: 24,
      width: 60,
      height: 14,
      backgroundColor: "#1a1a2e",
      zIndex: 1,
      borderStyle: "single",
      borderColor: "#FFFFFF",
      title: "Animation Values",
      titleAlignment: "center",
    })
    this.parentContainer.add(statusBox)

    this.statusLine1 = new TextRenderable(renderer, {
      id: "status-line1",
      content: "Timeline: Initializing...",
      position: "absolute",
      left: 4,
      top: 25,
      fg: "#FFFFFF",
      zIndex: 2,
    })
    this.parentContainer.add(this.statusLine1)

    this.statusLine2 = new TextRenderable(renderer, {
      id: "status-line2",
      content: "Box Position: x=0.0, y=0.0",
      position: "absolute",
      left: 4,
      top: 26,
      fg: "#FFFF00",
      zIndex: 2,
    })
    this.parentContainer.add(this.statusLine2)

    this.statusLine3 = new TextRenderable(renderer, {
      id: "status-line3",
      content: "Box Scale/Rot: scale=1.0, rot=0.0",
      position: "absolute",
      left: 4,
      top: 27,
      fg: "#FFE66D",
      zIndex: 2,
    })
    this.parentContainer.add(this.statusLine3)

    this.statusLine4 = new TextRenderable(renderer, {
      id: "status-line4",
      content: "Color: rgb(255, 0, 0)",
      position: "absolute",
      left: 4,
      top: 28,
      fg: "#FF6B6B",
      zIndex: 2,
    })
    this.parentContainer.add(this.statusLine4)

    this.statusLine5 = new TextRenderable(renderer, {
      id: "status-line5",
      content: "Color Opacity: 1.0",
      position: "absolute",
      left: 4,
      top: 29,
      fg: "#FF9999",
      zIndex: 2,
    })
    this.parentContainer.add(this.statusLine5)

    this.statusLine6 = new TextRenderable(renderer, {
      id: "status-line6",
      content: "Physics: v=0.0, a=0.0, m=1.0",
      position: "absolute",
      left: 4,
      top: 30,
      fg: "#4ECDC4",
      zIndex: 2,
    })
    this.parentContainer.add(this.statusLine6)

    this.statusLine7 = new TextRenderable(renderer, {
      id: "status-line7",
      content: "Progress: Main=0% Sub1=0% Sub2=0%",
      position: "absolute",
      left: 4,
      top: 31,
      fg: "#CCCCCC",
      zIndex: 2,
    })
    this.parentContainer.add(this.statusLine7)

    this.statusLine8 = new TextRenderable(renderer, {
      id: "status-line8",
      content: "Example Value: 0.000 (0.0 → 0.5)",
      position: "absolute",
      left: 4,
      top: 32,
      fg: "#FFE66D",
      zIndex: 2,
    })
    this.parentContainer.add(this.statusLine8)

    this.statusLine9 = new TextRenderable(renderer, {
      id: "status-line9",
      content: "Alternating: x=65 (left/right loop=5)",
      position: "absolute",
      left: 4,
      top: 33,
      fg: "#9B59B6",
      zIndex: 2,
    })
    this.parentContainer.add(this.statusLine9)
  }

  public update = async (): Promise<void> => {
    // Update timeline progress bars
    const mainProgress = (this._mainTimeline.currentTime / this._mainTimeline.duration) * 58
    const sub1Progress = (this._subTimeline1.currentTime / this._subTimeline1.duration) * 28
    const sub2Progress = (this._subTimeline2.currentTime / this._subTimeline2.duration) * 25

    // Create progress indicators
    const mainProgressBox = this.parentContainer.getRenderable("main-progress") as BoxRenderable
    if (mainProgressBox) {
      mainProgressBox.width = Math.max(1, Math.floor(mainProgress))
    } else {
      const newMainProgressBox = new BoxRenderable(this.renderer, {
        id: "main-progress",
        position: "absolute",
        left: 3,
        top: 16,
        width: Math.max(1, Math.floor(mainProgress)),
        height: 1,
        backgroundColor: "#FFE66D",
        zIndex: 2,
      })
      this.parentContainer.add(newMainProgressBox)
    }

    const sub1ProgressBox = this.parentContainer.getRenderable("sub1-progress") as BoxRenderable
    if (sub1ProgressBox) {
      sub1ProgressBox.width = Math.max(1, Math.floor(sub1Progress))
    } else {
      const newSub1ProgressBox = new BoxRenderable(this.renderer, {
        id: "sub1-progress",
        position: "absolute",
        left: 3,
        top: 20,
        width: Math.max(1, Math.floor(sub1Progress)),
        height: 1,
        backgroundColor: "#FF6B6B",
        zIndex: 2,
      })
      this.parentContainer.add(newSub1ProgressBox)
    }

    const sub2ProgressBox = this.parentContainer.getRenderable("sub2-progress") as BoxRenderable
    if (sub2ProgressBox) {
      sub2ProgressBox.width = Math.max(1, Math.floor(sub2Progress))
    } else {
      const newSub2ProgressBox = new BoxRenderable(this.renderer, {
        id: "sub2-progress",
        position: "absolute",
        left: 36,
        top: 20,
        width: Math.max(1, Math.floor(sub2Progress)),
        height: 1,
        backgroundColor: "#4ECDC4",
        zIndex: 2,
      })
      this.parentContainer.add(newSub2ProgressBox)
    }

    const mainPercent = Math.floor((this._mainTimeline.currentTime / this._mainTimeline.duration) * 100)
    const sub1Percent = Math.floor((this._subTimeline1.currentTime / this._subTimeline1.duration) * 100)
    const sub2Percent = Math.floor((this._subTimeline2.currentTime / this._subTimeline2.duration) * 100)

    this.statusLine7.content = `Progress: Main=${mainPercent}% Sub1=${sub1Percent}% Sub2=${sub2Percent}%`
  }

  private setupAnimations(): void {
    const boxObject = {
      x: 0,
      y: 0,
      scale: 1.0,
      rotation: 0,
    }

    const colorObject = {
      red: 255,
      green: 0,
      blue: 0,
      opacity: 1.0,
    }

    const physicsObject = {
      velocity: 0,
      acceleration: 0,
      mass: 1.0,
    }

    const exampleValue = {
      value: 0.0,
    }

    const alternatingObject = {
      x: 1,
    }

    // Sub-timeline 1: Box animations
    this._subTimeline1.add(
      boxObject,
      {
        x: 100,
        y: 50,
        duration: 2000,
        ease: "inOutQuad",
        onUpdate: (values: JSAnimation) => {
          const x = values.targets[0].x
          const y = values.targets[0].y

          this.boxObject.x = Math.max(1, Math.min(70, 10 + Math.round(x / 3)))
          this.boxObject.y = Math.max(1, Math.min(30, 8 + Math.round(y / 5)))

          this.statusLine2.content = `Box Position: x=${x.toFixed(1)}, y=${y.toFixed(1)}`
        },
      },
      0,
    )

    this._subTimeline1.add(
      boxObject,
      {
        scale: 2.0,
        rotation: Math.PI,
        duration: 1500,
        ease: "inOutQuad",
        onUpdate: (values: JSAnimation) => {
          const scale = values.targets[0].scale
          const rotation = values.targets[0].rotation
          const size = Math.max(4, Math.round(4 * scale))
          this.boxObject.width = size
          this.boxObject.height = Math.max(2, Math.round(size / 2))

          this.statusLine3.content = `Box Scale/Rot: scale=${scale.toFixed(2)}, rot=${rotation.toFixed(2)}`
        },
      },
      1000,
    )

    this._subTimeline1.add(
      boxObject,
      {
        x: -50,
        y: -25,
        scale: 0.5,
        rotation: 0,
        duration: 3000,
        ease: "inOutSine",
        onUpdate: (values: JSAnimation) => {
          const x = values.targets[0].x
          const y = values.targets[0].y
          const scale = values.targets[0].scale
          const rotation = values.targets[0].rotation

          this.boxObject.x = Math.max(1, Math.min(70, 10 + Math.round(x / 3)))
          this.boxObject.y = Math.max(1, Math.min(30, 8 + Math.round(y / 5)))

          const size = Math.max(2, Math.round(4 * scale))
          this.boxObject.width = size
          this.boxObject.height = Math.max(1, Math.round(size / 2))

          this.statusLine2.content = `Box Position (Reset): x=${x.toFixed(1)}, y=${y.toFixed(1)}`
          this.statusLine3.content = `Box Scale/Rot (Reset): scale=${scale.toFixed(2)}, rot=${rotation.toFixed(2)}`
        },
      },
      4000,
    )

    this._subTimeline2.add(
      colorObject,
      {
        red: 0,
        green: 255,
        blue: 128,
        duration: 2000,
        ease: "linear",
        onUpdate: (values: JSAnimation) => {
          const r = Math.round(values.targets[0].red)
          const g = Math.round(values.targets[0].green)
          const b = Math.round(values.targets[0].blue)

          const hexColor = `#${r.toString(16).padStart(2, "0")}${g.toString(16).padStart(2, "0")}${b.toString(16).padStart(2, "0")}`
          const colorObject = this.parentContainer.getRenderable("color-object") as BoxRenderable
          if (colorObject) {
            colorObject.backgroundColor = hexColor
          }

          this.statusLine4.content = `Color: rgb(${r}, ${g}, ${b})`
        },
      },
      0,
    )

    this._subTimeline2.add(
      colorObject,
      {
        opacity: 0.2,
        duration: 1000,
        ease: "inExpo",
        onUpdate: (values: JSAnimation) => {
          const opacity = values.targets[0].opacity
          this.statusLine5.content = `Color Opacity: ${opacity.toFixed(2)}`
        },
      },
      1500,
    )

    this._subTimeline2.add(
      colorObject,
      {
        red: 255,
        green: 255,
        blue: 0,
        opacity: 1.0,
        duration: 2500,
        ease: "outExpo",
        onUpdate: (values: JSAnimation) => {
          const r = Math.round(values.targets[0].red)
          const g = Math.round(values.targets[0].green)
          const b = Math.round(values.targets[0].blue)
          const opacity = values.targets[0].opacity

          const hexColor = `#${r.toString(16).padStart(2, "0")}${g.toString(16).padStart(2, "0")}${b.toString(16).padStart(2, "0")}`
          const colorObject = this.parentContainer.getRenderable("color-object") as BoxRenderable
          if (colorObject) {
            colorObject.backgroundColor = hexColor
          }

          this.statusLine4.content = `Final Color: rgb(${r}, ${g}, ${b}), opacity=${opacity.toFixed(2)}`
        },
      },
      3500,
    )

    this._mainTimeline.call(() => {
      this.statusLine1.content = "=== STARTING ANIMATION CYCLE ==="
    }, 0)

    this._mainTimeline.add(
      exampleValue,
      {
        value: 0.5,
        duration: 10000,
        ease: "inOutSine",
        onUpdate: (values: JSAnimation) => {
          const val = values.targets[0].value
          this.statusLine8.content = `Example Value: ${val.toFixed(3)} (0.0 → 0.5)`
        },
      },
      0,
    )

    this._mainTimeline.add(
      alternatingObject,
      {
        x: 50,
        duration: 800,
        ease: "inOutQuad",
        loop: 5,
        alternate: true,
        loopDelay: 200,
        onUpdate: (values: JSAnimation) => {
          const x = values.targets[0].x
          this.alternatingObject.x = Math.round(x)
          this.alternatingObject.y = 1
          this.statusLine9.content = `Alternating: x=${x.toFixed(1)} (left/right loop=5)`
        },
      },
      1000,
    )

    this._mainTimeline.add(
      physicsObject,
      {
        velocity: 50,
        acceleration: 9.8,
        mass: 2.5,
        duration: 4000,
        ease: "inOutSine",
        onUpdate: (values: JSAnimation) => {
          const velocity = values.targets[0].velocity
          const acceleration = values.targets[0].acceleration
          const mass = values.targets[0].mass
          const velocityHeight = Math.max(1, Math.round(velocity / 6))
          const physicsObject = this.parentContainer.getRenderable("physics-object") as BoxRenderable
          if (physicsObject) {
            physicsObject.height = Math.min(6, velocityHeight)
          }

          this.statusLine6.content = `Physics: v=${velocity.toFixed(1)}, a=${acceleration.toFixed(1)}, m=${mass.toFixed(1)}`
        },
      },
      1000,
    )

    this._mainTimeline.add(
      physicsObject,
      {
        velocity: -20,
        acceleration: -5,
        mass: 0.8,
        duration: 3000,
        ease: "inOutSine",
        onUpdate: (values: JSAnimation) => {
          const velocity = values.targets[0].velocity
          const acceleration = values.targets[0].acceleration
          const mass = values.targets[0].mass

          const velocityHeight = Math.max(1, Math.abs(Math.round(velocity / 4)))
          const physicsObject = this.parentContainer.getRenderable("physics-object") as BoxRenderable
          if (physicsObject) {
            physicsObject.height = Math.min(6, velocityHeight)
          }

          this.statusLine6.content = `Physics Reverse: v=${velocity.toFixed(1)}, a=${acceleration.toFixed(1)}, m=${mass.toFixed(1)}`
        },
      },
      8000,
    )

    this._mainTimeline.call(() => {
      this.statusLine1.content = "=== CYCLE COMPLETE ==="
    }, 9000)
  }

  public start(): void {
    this.statusLine1.content = "Starting nested timeline example..."
    this._mainTimeline.play()
  }

  public pause(): void {
    this._mainTimeline.pause()
  }

  public destroy(): void {
    this.renderer.removeFrameCallback(this.update)
    this._mainTimeline.pause()
    this.animationEngine.unregister(this._mainTimeline)
    this.parentContainer.destroyRecursively()
  }
}

const examples = new WeakMap<CliRenderer, TimelineExample>()

export function run(renderer: CliRenderer): void {
  renderer.start()
  renderer.setBackgroundColor("#000028")

  const example = new TimelineExample(renderer)
  examples.set(renderer, example)
  example.start()

  renderer.setFrameCallback(example.update)

  const keyHandler = (key: KeyEvent) => {
    if (key.name === "p") {
      example.pause()
    }

    if (key.name === "r") {
      example.start()
    }
  }
  renderer.keyInput.on("keypress", keyHandler)
  renderer.root.getRenderable("timeline-container")!.once("destroyed", () => {
    renderer.keyInput.off("keypress", keyHandler)
  })
}

export function destroy(renderer: CliRenderer): void {
  const example = examples.get(renderer)
  examples.delete(renderer)
  example?.destroy()
}

if (import.meta.main) {
  const renderer = await createCliRenderer({
    exitOnCtrlC: true,
    targetFps: 60,
  })

  setupCommonDemoKeys(renderer)
  run(renderer)
}
