/**
 * BorderConfig configuration options
 * 
 * @public
 * @category Configuration
 */
export interface BorderConfig {
  border: boolean | BorderSides[];

  borderColor?: ColorInput;

  borderStyle: BorderStyle;

  customBorderChars?: BorderCharacters;

}
