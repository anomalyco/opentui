/**
 * OpenTUI IntelliSense Definitions
 * 
 * This file provides comprehensive type definitions and IntelliSense support
 * for OpenTUI components and APIs.
 * 
 * @packageDocumentation
 */

import * as Types from './types/index.d.ts';

declare module '@opentui/core' {
  // Re-export all types
  export * from './types';
  
  // Component Classes
  export class Renderable {
    constructor(id: string, options?: RenderableOptions);
    
    /** Unique identifier */
    id: string;
    
    /** X position */
    x: number;
    
    /** Y position */
    y: number;
    
    /** Width */
    width: number;
    
    /** Height */
    height: number;
    
    /** Visibility state */
    visible: boolean;
    
    /** Focus state */
    focused: boolean;
    
    /** Parent component */
    parent: Renderable | null;
    
    /** Child components */
    children: Renderable[];
    
    // Methods
    add(child: Renderable, index?: number): number;
    remove(id: string): void;
    focus(): void;
    blur(): void;
    needsUpdate(): void;
    destroy(): void;
    handleKeyPress(key: ParsedKey | string): boolean;
    getSelectedText(): string;
    hasSelection(): boolean;
  }
  
  export class BoxRenderable extends Renderable {
    constructor(id: string, options?: BoxOptions);
    
    /** Border visibility */
    border: boolean | [boolean, boolean, boolean, boolean];
    
    /** Border style */
    borderStyle: BorderStyle;
    
    /** Box title */
    title?: string;
    
    /** Padding */
    padding: number | { top: number; right: number; bottom: number; left: number };
    
    // Methods
    setBorderStyle(style: BorderStyle): void;
    setTitle(title: string): void;
    setPadding(padding: number | { top: number; right: number; bottom: number; left: number }): void;
    showBorder(show: boolean): void;
  }
  
  export class TextRenderable extends Renderable {
    constructor(id: string, options?: TextOptions);
    
    /** Text content */
    text: string;
    
    /** Text color */
    color: string | RGBA;
    
    /** Background color */
    backgroundColor?: string | RGBA;
    
    /** Text alignment */
    align: 'left' | 'center' | 'right';
    
    /** Word wrap enabled */
    wrap: boolean;
    
    /** Text is selectable */
    selectable: boolean;
    
    // Methods
    setText(text: string): void;
    setColor(color: string | RGBA): void;
    setAlign(align: 'left' | 'center' | 'right'): void;
  }
  
  export class InputRenderable extends Renderable {
    constructor(id: string, options?: InputRenderableOptions);
    
    /** Current value */
    value: string;
    
    /** Placeholder text */
    placeholder?: string;
    
    /** Maximum length */
    maxLength?: number;
    
    /** Password mode */
    password?: boolean;
    
    /** Cursor position */
    cursorPosition: number;
    
    // Methods
    setValue(value: string): void;
    clear(): void;
    selectAll(): void;
    setCursorPosition(position: number): void;
    insertText(text: string): void;
    deleteSelection(): void;
    validate(): boolean;
  }
  
  export class ASCIIFontRenderable extends Renderable {
    constructor(id: string, options?: ASCIIFontOptions);
    
    /** Display text */
    text: string;
    
    /** Font name or definition */
    font: string | FontDefinition;
    
    /** Text color */
    color: string | RGBA;
    
    // Methods
    setText(text: string): void;
    setFont(font: string | FontDefinition): void;
    static registerFont(name: string, definition: FontDefinition): void;
  }
  
  export class CliRenderer {
    constructor(
      lib: any,
      ptr: any,
      stdin: NodeJS.ReadStream,
      stdout: NodeJS.WriteStream,
      width: number,
      height: number,
      config?: CliRendererConfig
    );
    
    /** Terminal width */
    width: number;
    
    /** Terminal height */
    height: number;
    
    /** Root component */
    root: RootRenderable;
    
    // Methods
    start(): void;
    stop(): void;
    resize(width: number, height: number): void;
    needsUpdate(): void;
    toggleDebugOverlay(): void;
    setBackgroundColor(color: string | RGBA): void;
  }
  
  export class Timeline {
    constructor(options?: TimelineOptions);
    
    /** Timeline duration */
    duration: number;
    
    /** Loop enabled */
    loop: boolean;
    
    /** Playing state */
    isPlaying: boolean;
    
    /** Current time */
    currentTime: number;
    
    // Methods
    add(animation: AnimationOptions): Timeline;
    play(): Promise<void>;
    pause(): void;
    stop(): void;
    seek(time: number): void;
    remove(animation: AnimationOptions): void;
  }
  
  export class OptimizedBuffer {
    constructor(width: number, height: number);
    
    /** Buffer width */
    width: number;
    
    /** Buffer height */
    height: number;
    
    // Methods
    drawText(text: string, x: number, y: number, fg?: RGBA, bg?: RGBA): void;
    drawBox(x: number, y: number, width: number, height: number, options?: BoxDrawOptions): void;
    setCell(x: number, y: number, char: string, fg?: RGBA, bg?: RGBA): void;
    clear(x?: number, y?: number, width?: number, height?: number): void;
    copyFrom(source: OptimizedBuffer, x: number, y: number): void;
    markDirty(x: number, y: number, width: number, height: number): void;
    getDirtyRegion(): { x: number; y: number; width: number; height: number } | null;
  }
  
  // Helper Types
  export interface ParsedKey {
    name: string;
    ctrl: boolean;
    meta: boolean;
    shift: boolean;
    alt: boolean;
    sequence?: string;
    code?: string;
  }
  
  export interface MouseEvent {
    type: MouseEventType;
    button: number;
    x: number;
    y: number;
    source: Renderable;
    target: Renderable | null;
    modifiers: {
      shift: boolean;
      alt: boolean;
      ctrl: boolean;
    };
    scroll?: {
      direction: 'up' | 'down';
      delta: number;
    };
    preventDefault(): void;
  }
  
  export interface FontDefinition {
    height: number;
    chars: {
      [char: string]: string[];
    };
    kerning?: {
      [pair: string]: number;
    };
  }
  
  export interface RGBA {
    r: number;
    g: number;
    b: number;
    a: number;
    
    static fromHex(hex: string): RGBA;
    static fromValues(r: number, g: number, b: number, a: number): RGBA;
    static fromHSL(h: number, s: number, l: number, a?: number): RGBA;
    static white(): RGBA;
    static black(): RGBA;
    static transparent(): RGBA;
    static blend(from: RGBA, to: RGBA, alpha: number): RGBA;
  }
  
  // Enums
  export type MouseEventType = 
    | 'down' 
    | 'up' 
    | 'move' 
    | 'drag' 
    | 'drag-end' 
    | 'drop' 
    | 'over' 
    | 'out' 
    | 'scroll';
  
  export type BorderStyle = 'single' | 'double' | 'rounded' | 'heavy';
  
  export type AlignString = 'flex-start' | 'flex-end' | 'center' | 'stretch' | 'baseline';
  
  export type JustifyString = 'flex-start' | 'flex-end' | 'center' | 'space-between' | 'space-around' | 'space-evenly';
  
  export type FlexDirectionString = 'row' | 'column' | 'row-reverse' | 'column-reverse';
  
  export type PositionTypeString = 'relative' | 'absolute';
  
  // Easing Functions
  export const Easing: {
    linear: (t: number) => number;
    easeInQuad: (t: number) => number;
    easeOutQuad: (t: number) => number;
    easeInOutQuad: (t: number) => number;
    easeInCubic: (t: number) => number;
    easeOutCubic: (t: number) => number;
    easeInOutCubic: (t: number) => number;
    easeInExpo: (t: number) => number;
    easeOutExpo: (t: number) => number;
    easeInOutExpo: (t: number) => number;
    easeInBounce: (t: number) => number;
    easeOutBounce: (t: number) => number;
    easeInOutBounce: (t: number) => number;
    easeInElastic: (t: number) => number;
    easeOutElastic: (t: number) => number;
    easeInOutElastic: (t: number) => number;
    easeInBack: (t: number) => number;
    easeOutBack: (t: number) => number;
    easeInOutBack: (t: number) => number;
  };
  
  // Debug
  export enum DebugOverlayCorner {
    TOP_LEFT = 'top-left',
    TOP_RIGHT = 'top-right',
    BOTTOM_LEFT = 'bottom-left',
    BOTTOM_RIGHT = 'bottom-right'
  }
}

// Global type augmentations for better IntelliSense
declare global {
  namespace NodeJS {
    interface ProcessEnv {
      OPENTUI_DEBUG?: string;
      OPENTUI_THEME?: string;
      OPENTUI_RENDERER?: string;
    }
  }
}

export {};