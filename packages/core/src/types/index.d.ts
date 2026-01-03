/**
 * OpenTUI Type Definitions
 * 
 * This module exports all configuration interfaces and types used by OpenTUI components.
 * 
 * @module @opentui/core/types
 * @packageDocumentation
 */

// Component Options
export type { ASCIIFontOptions } from './ASCIIFontOptions';
export type { AnimationOptions } from './AnimationOptions';
export type { BorderConfig } from './BorderConfig';
export type { BoxDrawOptions } from './BoxDrawOptions';
export type { BoxOptions } from './BoxOptions';
export type { CliRendererConfig } from './CliRendererConfig';
export type { ConsoleOptions } from './ConsoleOptions';
export type { ExplosionEffectParameters } from './ExplosionEffectParameters';
export type { FrameBufferOptions } from './FrameBufferOptions';
export type { InputRenderableOptions } from './InputRenderableOptions';
export type { LayoutOptions } from './LayoutOptions';
export type { RenderableOptions } from './RenderableOptions';
export type { SelectRenderableOptions } from './SelectRenderableOptions';
export type { TabSelectRenderableOptions } from './TabSelectRenderableOptions';
export type { TextOptions } from './TextOptions';
export type { ThreeCliRendererOptions } from './ThreeCliRendererOptions';
export type { TimelineOptions } from './TimelineOptions';

// Re-export commonly used types
export type {
  BoxOptions,
  TextOptions,
  InputRenderableOptions,
  ASCIIFontOptions,
  AnimationOptions,
  TimelineOptions,
  CliRendererConfig
} from './index';

/**
 * Common color input type
 */
export type ColorInput = string | RGBA;

/**
 * RGBA color representation
 */
export interface RGBA {
  r: number;
  g: number;
  b: number;
  a: number;
}

/**
 * Border style options
 */
export type BorderStyle = 'single' | 'double' | 'rounded' | 'heavy';

/**
 * Flexbox alignment options
 */
export type AlignString = 'flex-start' | 'flex-end' | 'center' | 'stretch' | 'baseline';

/**
 * Flexbox justification options
 */
export type JustifyString = 'flex-start' | 'flex-end' | 'center' | 'space-between' | 'space-around' | 'space-evenly';

/**
 * Flexbox direction options
 */
export type FlexDirectionString = 'row' | 'column' | 'row-reverse' | 'column-reverse';

/**
 * Position type options
 */
export type PositionTypeString = 'relative' | 'absolute';
