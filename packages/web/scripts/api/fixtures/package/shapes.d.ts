import { EventEmitter } from "events"
/** @deprecated Use `area(width, height)`. */
export declare function area(radius: number): number
export declare function area(width: number, height: number): number
export declare class Base extends EventEmitter {
  baseMethod(): void
}
export declare class Shape extends Base implements Drawable {
  #private
  private secret
  /** @internal */
  internalMember: number
  _hidden: string
  protected _subclassState: number
  readonly id: string
  optional?: boolean
  constructor(id: string)
  protected render(): void
  static create(): Shape
  get size(): number
  get label(): string
  set label(value: string)
  static get count(): number
  /** @deprecated Use `overload`. */
  old(): void
  overload(a: string): void
  overload(a: number): void
  draw(): void
}
export declare abstract class Abstract<T extends object = {}> {
  protected abstract paint(target: T): void
  static readonly DEFAULT = 1
}
export interface Drawable {
  draw(): void
  /** Calls the drawable. */
  (x: number): string
  new (x: number): Drawable
  readonly [index: number]: string
  "quoted-name"?: boolean
}
export interface Drawable {
  merged: {
    /** A comment that must not appear. */
    nested: string
    other: number
  }
}
export declare enum Color {
  Red = 0,
  Blue = "blue",
}
export type ColorInput = string | Color | import("./widget.js").Widget
export declare const VERSION = "1.0.0"
export declare let mutable: number
export declare namespace Geometry {
  function distance(a: number, b: number): number
  namespace Units {
    const scale: number
  }
}
