/**
 * ASCIIFontOptions configuration options
 * 
 * @public
 * @category Configuration
 */
export interface ASCIIFontOptions {
  alignItems?: AlignString;

  bg?: RGBA;

  bottom?: number | string | string;

  buffered?: boolean;

  enableLayout?: boolean;

  fg?: RGBA | RGBA[];

  flexBasis?: number | string;

  flexDirection?: FlexDirectionString;

  flexGrow?: number;

  flexShrink?: number;

  font?: 'tiny' | 'block' | 'shade' | 'slick';

  height?: number | string | string;

  justifyContent?: JustifyString;

  left?: number | string | string;

  live?: boolean;

  margin?: number | string | string;

  marginBottom?: number | string | string;

  marginLeft?: number | string | string;

  marginRight?: number | string | string;

  marginTop?: number | string | string;

  maxHeight?: number;

  maxWidth?: number;

  minHeight?: number;

  minWidth?: number;

  /**
   * (key: ParsedKey) => void
   */
  onKeyDown?: { namedArgs: { key: ParsedKey } };

  /**
   * (event: MouseEvent) => void
   */
  onMouseDown?: { namedArgs: { event: MouseEvent } };

  /**
   * (event: MouseEvent) => void
   */
  onMouseDrag?: { namedArgs: { event: MouseEvent } };

  /**
   * (event: MouseEvent) => void
   */
  onMouseDragEnd?: { namedArgs: { event: MouseEvent } };

  /**
   * (event: MouseEvent) => void
   */
  onMouseDrop?: { namedArgs: { event: MouseEvent } };

  /**
   * (event: MouseEvent) => void
   */
  onMouseMove?: { namedArgs: { event: MouseEvent } };

  /**
   * (event: MouseEvent) => void
   */
  onMouseOut?: { namedArgs: { event: MouseEvent } };

  /**
   * (event: MouseEvent) => void
   */
  onMouseOver?: { namedArgs: { event: MouseEvent } };

  /**
   * (event: MouseEvent) => void
   */
  onMouseScroll?: { namedArgs: { event: MouseEvent } };

  /**
   * (event: MouseEvent) => void
   */
  onMouseUp?: { namedArgs: { event: MouseEvent } };

  padding?: any;

  paddingBottom?: any;

  paddingLeft?: any;

  paddingRight?: any;

  paddingTop?: any;

  position?: PositionTypeString;

  right?: number | string | string;

  selectable?: boolean;

  selectionBg?: string | RGBA;

  selectionFg?: string | RGBA;

  text?: string;

  top?: number | string | string;

  visible?: boolean;

  width?: number | string | string;

  zIndex?: number;

}
