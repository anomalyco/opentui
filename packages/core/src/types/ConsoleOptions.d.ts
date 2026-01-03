/**
 * ConsoleOptions configuration options
 * 
 * @public
 * @category Configuration
 */
export interface ConsoleOptions {
  backgroundColor?: ColorInput;

  colorDebug?: ColorInput;

  colorDefault?: ColorInput;

  colorError?: ColorInput;

  colorInfo?: ColorInput;

  colorWarn?: ColorInput;

  cursorColor?: ColorInput;

  maxDisplayLines?: number;

  maxStoredLogs?: number;

  position?: ConsolePosition;

  sizePercent?: number;

  startInDebugMode?: boolean;

  title?: string;

  titleBarColor?: ColorInput;

  titleBarTextColor?: ColorInput;

  zIndex?: number;

}
