/**
 * SelectRenderableOptions configuration options
 * 
 * @public
 * @category Configuration
 */
export interface SelectRenderableOptions {
  alignItems?: AlignString;

  backgroundColor?: ColorInput;

  bottom?: number | string | string;

  buffered?: boolean;

  descriptionColor?: ColorInput;

  enableLayout?: boolean;

  fastScrollStep?: number;

  flexBasis?: number | string;

  flexDirection?: FlexDirectionString;

  flexGrow?: number;

  flexShrink?: number;

  focusedBackgroundColor?: ColorInput;

  focusedTextColor?: ColorInput;

  font?: 'tiny' | 'block' | 'shade' | 'slick';

  height?: number | string | string;

  itemSpacing?: number;

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

  options?: SelectOption[];

  padding?: any;

  paddingBottom?: any;

  paddingLeft?: any;

  paddingRight?: any;

  paddingTop?: any;

  position?: PositionTypeString;

  right?: number | string | string;

  selectedBackgroundColor?: ColorInput;

  selectedDescriptionColor?: ColorInput;

  selectedTextColor?: ColorInput;

  showDescription?: boolean;

  showScrollIndicator?: boolean;

  textColor?: ColorInput;

  top?: number | string | string;

  visible?: boolean;

  width?: number | string | string;

  wrapSelection?: boolean;

  zIndex?: number;

}
