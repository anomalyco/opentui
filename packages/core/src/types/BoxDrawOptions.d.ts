/**
 * BoxDrawOptions configuration options
 * 
 * @public
 * @category Configuration
 */
export interface BoxDrawOptions {
  backgroundColor: ColorInput;

  border: boolean | BorderSides[];

  borderColor: ColorInput;

  borderStyle: BorderStyle;

  customBorderChars?: BorderCharacters;

  height: number;

  shouldFill?: boolean;

  title?: string;

  titleAlignment?: 'left' | 'center' | 'right';

  width: number;

  x: number;

  y: number;

}
