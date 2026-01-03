#!/usr/bin/env bun

import {
  CliRenderer,
  createCliRenderer,
  TextRenderable,
  FrameBufferRenderable,
  RGBA,
  SelectRenderable,
  SelectRenderableEvents,
  BoxRenderable,
  type SelectOption,
  type KeyEvent,
  ASCIIFontRenderable,
} from "../index"
import { measureText } from "../lib/ascii.font"
import * as goldenStarDemo from "./golden-star-demo"
import * as boxExample from "./fonts"
import * as fractalShaderExample from "./fractal-shader-demo"
import * as framebufferExample from "./framebuffer-demo"
import * as lightsPhongExample from "./lights-phong-demo"
import * as physxPlanckExample from "./physx-planck-2d-demo"
import * as physxRapierExample from "./physx-rapier-2d-demo"
import * as opentuiDemo from "./opentui-demo"
import * as nestedZIndexDemo from "./nested-zindex-demo"
import * as relativePositioningDemo from "./relative-positioning-demo"
import * as transparencyDemo from "./transparency-demo"
import * as scrollExample from "./scroll-example"
import * as stickyScrollExample from "./sticky-scroll-example"
import * as shaderCubeExample from "./shader-cube-demo"
import * as spriteAnimationExample from "./sprite-animation-demo"
import * as spriteParticleExample from "./sprite-particle-generator-demo"
import * as staticSpriteExample from "./static-sprite-demo"
import * as textureLoadingExample from "./texture-loading-demo"
import * as timelineExample from "./timeline-example"
import * as tabSelectExample from "./tab-select-demo"
import * as selectExample from "./select-demo"
import * as inputExample from "./input-demo"
import * as layoutExample from "./simple-layout-example"
import * as inputSelectLayoutExample from "./input-select-layout-demo"
import * as styledTextExample from "./styled-text-demo"
import * as mouseInteractionExample from "./mouse-interaction-demo"
import * as textSelectionExample from "./text-selection-demo"
import * as asciiFontSelectionExample from "./ascii-font-selection-demo"
import * as splitModeExample from "./split-mode-demo"
import * as consoleExample from "./console-demo"
import * as vnodeCompositionDemo from "./vnode-composition-demo"
import * as hastSyntaxHighlightingExample from "./hast-syntax-highlighting-demo"
import * as codeDemo from "./code-demo"
import * as liveStateExample from "./live-state-demo"
import * as fullUnicodeExample from "./full-unicode-demo"
import * as textNodeDemo from "./text-node-demo"
import * as textWrapExample from "./text-wrap"
import * as editorDemo from "./editor-demo"
import * as sliderDemo from "./slider-demo"
import * as terminalDemo from "./terminal"
import * as diffDemo from "./diff-demo"
import * as keypressDebugDemo from "./keypress-debug-demo"
import * as extmarksDemo from "./extmarks-demo"
import * as markdownDemo from "./markdown-demo"
import * as opacityExample from "./opacity-example"
import { setupCommonDemoKeys } from "./lib/standalone-keys"

interface Example {
  name: string
  description: string
  run?: (renderer: CliRenderer) => void
  destroy?: (renderer: CliRenderer) => void
}

const examples: Example[] = [
  {
    name: "Golden Star Demo",
    description: "3D golden star with particle effects and animated text celebrating 5000 stars",
    run: goldenStarDemo.run,
    destroy: goldenStarDemo.destroy,
  },
  {
    name: "Mouse Interaction Demo",
    description: "Interactive mouse trails and clickable cells demonstration",
    run: mouseInteractionExample.run,
    destroy: mouseInteractionExample.destroy,
  },
  {
    name: "Text Selection Demo",
    description: "Text selection across multiple renderables with mouse drag",
    run: textSelectionExample.run,
    destroy: textSelectionExample.destroy,
  },
  {
    name: "ASCII Font Selection Demo",
    description: "Text selection with ASCII fonts - precise character-level selection across different font types",
    run: asciiFontSelectionExample.run,
    destroy: asciiFontSelectionExample.destroy,
  },
  {
    name: "Text Wrap Demo",
    description: "Text wrapping example",
    run: textWrapExample.run,
    destroy: textWrapExample.destroy,
  },
  {
    name: "Console Demo",
    description: "Interactive console logging with clickable buttons for different log levels",
    run: consoleExample.run,
    destroy: consoleExample.destroy,
  },
  {
    name: "Styled Text Demo",
    description: "Template literals with styled text, colors, and formatting",
    run: styledTextExample.run,
    destroy: styledTextExample.destroy,
  },
  {
    name: "TextNode Demo",
    description: "TextNode API for building complex styled text structures",
    run: textNodeDemo.run,
    destroy: textNodeDemo.destroy,
  },
  {
    name: "HAST Syntax Highlighting Demo",
    description: "Convert HAST trees to syntax-highlighted text with efficient chunk generation",
    run: hastSyntaxHighlightingExample.run,
    destroy: hastSyntaxHighlightingExample.destroy,
  },
  {
    name: "Code Demo",
    description:
      "Code viewer with line numbers, diff highlights, and diagnostics using CodeRenderable + LineNumberRenderable",
    run: codeDemo.run,
    destroy: codeDemo.destroy,
  },
  {
    name: "Diff Demo",
    description: "Unified and split diff views with syntax highlighting and multiple themes",
    run: diffDemo.run,
    destroy: diffDemo.destroy,
  },
  {
    name: "Markdown Demo",
    description: "Markdown rendering with table alignment, syntax highlighting, and theme switching",
    run: markdownDemo.run,
    destroy: markdownDemo.destroy,
  },
  {
    name: "Live State Management Demo",
    description: "Test automatic renderer lifecycle management with live renderables",
    run: liveStateExample.run,
    destroy: liveStateExample.destroy,
  },
  {
    name: "Layout System Demo",
    description: "Flex layout system with multiple configurations",
    run: layoutExample.run,
    destroy: layoutExample.destroy,
  },
  {
    name: "Input & Select Layout Demo",
    description: "Interactive layout with input and select elements",
    run: inputSelectLayoutExample.run,
    destroy: inputSelectLayoutExample.destroy,
  },
  {
    name: "ASCII Font Demo",
    description: "ASCII font rendering with various colors and text",
    run: boxExample.run,
    destroy: boxExample.destroy,
  },
  {
    name: "OpenTUI Demo",
    description: "Multi-tab demo with various features",
    run: opentuiDemo.run,
    destroy: opentuiDemo.destroy,
  },
  {
    name: "Nested Z-Index Demo",
    description: "Demonstrates z-index behavior with nested render objects",
    run: nestedZIndexDemo.run,
    destroy: nestedZIndexDemo.destroy,
  },
  {
    name: "Relative Positioning Demo",
    description: "Shows how child positions are relative to their parent containers",
    run: relativePositioningDemo.run,
    destroy: relativePositioningDemo.destroy,
  },
  {
    name: "Transparency Demo",
    description: "Alpha blending and transparency effects demonstration",
    run: transparencyDemo.run,
    destroy: transparencyDemo.destroy,
  },
  {
    name: "Opacity Demo",
    description: "Interactive opacity/alpha demonstration with animated boxes",
    run: opacityExample.run,
    destroy: opacityExample.destroy,
  },
  {
    name: "Static Sprite",
    description: "Static sprite rendering demo",
    run: staticSpriteExample.run,
    destroy: staticSpriteExample.destroy,
  },
  {
    name: "Sprite Animation",
    description: "Animated sprite sequences",
    run: spriteAnimationExample.run,
    destroy: spriteAnimationExample.destroy,
  },
  {
    name: "Sprite Particles",
    description: "Particle system with sprites",
    run: spriteParticleExample.run,
    destroy: spriteParticleExample.destroy,
  },
  {
    name: "Framebuffer Demo",
    description: "Framebuffer rendering techniques",
    run: framebufferExample.run,
    destroy: framebufferExample.destroy,
  },
  {
    name: "Texture Loading",
    description: "Loading and displaying textures",
    run: textureLoadingExample.run,
    destroy: textureLoadingExample.destroy,
  },
  {
    name: "ScrollBox Demo",
    description: "Scrollable container with customization",
    run: scrollExample.run,
    destroy: scrollExample.destroy,
  },
  {
    name: "Sticky Scroll Demo",
    description: "ScrollBox with sticky scroll behavior - maintains position at borders when content changes",
    run: stickyScrollExample.run,
    destroy: stickyScrollExample.destroy,
  },
  {
    name: "Shader Cube",
    description: "3D cube with custom shaders",
    run: shaderCubeExample.run,
    destroy: shaderCubeExample.destroy,
  },
  {
    name: "Fractal Shader",
    description: "Fractal rendering with shaders",
    run: fractalShaderExample.run,
    destroy: fractalShaderExample.destroy,
  },
  {
    name: "Phong Lighting",
    description: "Phong lighting model demo",
    run: lightsPhongExample.run,
    destroy: lightsPhongExample.destroy,
  },
  {
    name: "Physics Planck",
    description: "2D physics with Planck.js",
    run: physxPlanckExample.run,
    destroy: physxPlanckExample.destroy,
  },
  {
    name: "Physics Rapier",
    description: "2D physics with Rapier",
    run: physxRapierExample.run,
    destroy: physxRapierExample.destroy,
  },
  {
    name: "Timeline Example",
    description: "Animation timeline system",
    run: timelineExample.run,
    destroy: timelineExample.destroy,
  },
  {
    name: "Tab Select",
    description: "Tab selection demo",
    run: tabSelectExample.run,
    destroy: tabSelectExample.destroy,
  },
  {
    name: "Select Demo",
    description: "Interactive SelectElement demo with customizable options",
    run: selectExample.run,
    destroy: selectExample.destroy,
  },
  {
    name: "Input Demo",
    description: "Interactive InputElement demo with validation and multiple fields",
    run: inputExample.run,
    destroy: inputExample.destroy,
  },
  {
    name: "Terminal Palette Demo",
    description: "Terminal color palette detection and visualization - fetch and display all 256 terminal colors",
    run: terminalDemo.run,
    destroy: terminalDemo.destroy,
  },
  {
    name: "Editor Demo",
    description: "Interactive text editor with TextareaRenderable - supports full editing capabilities",
    run: editorDemo.run,
    destroy: editorDemo.destroy,
  },
  {
    name: "Extmarks Demo",
    description: "Virtual extmarks - text ranges that the cursor jumps over, with deletion handling",
    run: extmarksDemo.run,
    destroy: extmarksDemo.destroy,
  },
  {
    name: "Slider Demo",
    description: "Interactive slider components with various orientations and configurations",
    run: sliderDemo.run,
    destroy: sliderDemo.destroy,
  },
  {
    name: "VNode Composition Demo",
    description: "Declarative Box(Box(Box(children))) composition",
    run: vnodeCompositionDemo.run,
    destroy: vnodeCompositionDemo.destroy,
  },
  {
    name: "Full Unicode Demo",
    description: "Draggable boxes and background filled with complex graphemes",
    run: fullUnicodeExample.run,
    destroy: fullUnicodeExample.destroy,
  },
  {
    name: "Split Mode Demo (Experimental)",
    description: "Renderer confined to bottom area with normal terminal output above",
    run: splitModeExample.run,
    destroy: splitModeExample.destroy,
  },
  {
    name: "Keypress Debug Tool",
    description: "Debug tool to inspect keypress events, raw input, and terminal capabilities",
    run: keypressDebugDemo.run,
    destroy: keypressDebugDemo.destroy,
  },
]

class ExampleSelector {
  private renderer: CliRenderer
  private currentExample: Example | null = null
  private inMenu = true

  private title: FrameBufferRenderable | null = null
  private instructions: TextRenderable | null = null
  private selectElement: SelectRenderable | null = null
  private selectBox: BoxRenderable | null = null
  private notImplementedText: TextRenderable | null = null

  constructor(renderer: CliRenderer) {
    this.renderer = renderer
    this.createStaticElements()
    this.createSelectElement()
    this.setupKeyboardHandling()

    this.renderer.on("resize", (width: number, height: number) => {
      this.handleResize(width, height)
    })
  }

  private createTitle(width: number, height: number): void {
    const titleText = "OPENTUI EXAMPLES"
    const titleFont = "tiny"
    const { width: titleWidth } = measureText({ text: titleText, font: titleFont })
    const centerX = Math.floor(width / 2) - Math.floor(titleWidth / 2)

    this.title = new ASCIIFontRenderable(renderer, {
      id: "title",
      left: centerX,
      margin: 1,
      text: titleText,
      font: titleFont,
      color: RGBA.fromInts(240, 248, 255, 255),
      backgroundColor: RGBA.fromInts(15, 23, 42, 255),
    })
    this.renderer.root.add(this.title)
  }

  private createStaticElements(): void {
    const width = this.renderer.terminalWidth
    const height = this.renderer.terminalHeight

    this.createTitle(width, height)

    this.instructions = new TextRenderable(renderer, {
      id: "instructions",
      marginLeft: 2,
      marginRight: 2,
      content:
        "Use ↑↓ or j/k to navigate, Shift+↑↓ or Shift+j/k for fast scroll, Enter to run, Escape to return, ` for console, ctrl+z to suspend/resume, ctrl+c to quit",
      fg: "#94A3B8",
    })
    this.renderer.root.add(this.instructions)
  }

  private createSelectElement(): void {
    const selectOptions: SelectOption[] = examples.map((example) => ({
      name: example.name,
      description: example.description,
      value: example,
    }))

    this.selectBox = new BoxRenderable(renderer, {
      id: "example-selector-box",
      margin: 1,
      flexGrow: 1,
      borderStyle: "single",
      borderColor: "#475569",
      focusedBorderColor: "#60A5FA",
      title: "Examples",
      titleAlignment: "center",
      backgroundColor: "transparent",
      shouldFill: true,
      border: true,
    })

    this.selectElement = new SelectRenderable(renderer, {
      id: "example-selector",
      height: "100%",
      options: selectOptions,
      backgroundColor: "transparent",
      focusedBackgroundColor: "transparent",
      selectedBackgroundColor: "#1E3A5F",
      textColor: "#E2E8F0",
      selectedTextColor: "#38BDF8",
      descriptionColor: "#64748B",
      selectedDescriptionColor: "#94A3B8",
      showScrollIndicator: true,
      wrapSelection: true,
      showDescription: true,
      fastScrollStep: 5, // Shift+K/J or Shift+Up/Down moves 5 items at once
    })

    this.selectElement.on(SelectRenderableEvents.ITEM_SELECTED, (index: number, option: SelectOption) => {
      this.runSelected(option.value as Example)
    })

    this.renderer.root.add(this.selectBox)
    this.selectBox.add(this.selectElement)
    this.selectElement.focus()
  }

  private handleResize(width: number, height: number): void {
    if (this.title) {
      const titleWidth = this.title.frameBuffer.width
      const centerX = Math.floor(width / 2) - Math.floor(titleWidth / 2)
      this.title.x = centerX
    }

    this.renderer.requestRender()
  }

  private setupKeyboardHandling(): void {
    this.renderer.keyInput.on("keypress", (key: KeyEvent) => {
      if (!this.inMenu) {
        switch (key.name) {
          case "escape":
            this.returnToMenu()
            break
        }
      }
      if (key.name === "c" && key.ctrl) {
        this.cleanup()
        return
      }
      switch (key.name) {
        case "c":
          console.log("Capabilities:", this.renderer.capabilities)
          break
        case "z":
          if (key.ctrl) {
            console.log("Suspending renderer... (will auto-resume in 5 seconds)")
            this.renderer.suspend()
            setTimeout(() => {
              console.log("Resuming renderer...")
              this.renderer.resume()
            }, 5000)
          }
          break
      }
    })
    setupCommonDemoKeys(this.renderer)
  }

  private runSelected(selected: Example): void {
    this.inMenu = false
    this.hideMenuElements()

    if (selected.run) {
      this.currentExample = selected
      selected.run(this.renderer)
    } else {
      if (!this.notImplementedText) {
        this.notImplementedText = new TextRenderable(renderer, {
          id: "not-implemented",
          position: "absolute",
          left: 10,
          top: 10,
          content: `${selected.name} not yet implemented. Press Escape to return.`,
          fg: "#FFFF00",
          zIndex: 10,
        })
        this.renderer.root.add(this.notImplementedText)
      }
      this.renderer.requestRender()
    }
  }

  private hideMenuElements(): void {
    if (this.title) this.title.visible = false
    if (this.instructions) this.instructions.visible = false
    if (this.selectBox) {
      this.selectBox.visible = false
    }
    if (this.selectElement) {
      this.selectElement.blur()
    }
  }

  private showMenuElements(): void {
    if (this.title) this.title.visible = true
    if (this.instructions) this.instructions.visible = true
    if (this.selectBox) {
      this.selectBox.visible = true
    }
    if (this.selectElement) {
      this.selectElement.focus()
    }
  }

  private returnToMenu(): void {
    if (this.currentExample) {
      this.currentExample.destroy?.(this.renderer)
      this.currentExample = null
    }

    if (this.notImplementedText) {
      this.renderer.root.remove(this.notImplementedText.id)
      this.notImplementedText = null
    }

    this.inMenu = true
    this.restart()
  }

  private restart(): void {
    this.renderer.pause()
    this.renderer.auto()
    this.showMenuElements()
    this.renderer.setBackgroundColor("transparent")
    this.renderer.requestRender()
  }

  private cleanup(): void {
    if (this.currentExample) {
      this.currentExample.destroy?.(this.renderer)
    }
    if (this.selectElement) {
      this.selectElement.blur()
    }
    this.renderer.destroy()
  }
}

const renderer = await createCliRenderer({
  exitOnCtrlC: false,
  targetFps: 60,
  // useAlternateScreen: false,
})

renderer.setBackgroundColor("transparent")
new ExampleSelector(renderer)
