/**
 * CliRendererConfig configuration options
 * 
 * @public
 * @category Configuration
 */
export interface CliRendererConfig {
  consoleOptions?: ConsoleOptions;

  debounceDelay?: number;

  enableMouseMovement?: boolean;

  exitOnCtrlC?: boolean;

  experimental_splitHeight?: number;

  gatherStats?: boolean;

  maxStatSamples?: number;

  memorySnapshotInterval?: number;

  postProcessFns?: { namedArgs: { buffer: OptimizedBuffer; deltaTime: number } }[];

  stdin?: global.NodeJS.ReadStream;

  stdout?: global.NodeJS.WriteStream;

  targetFps?: number;

  useAlternateScreen?: boolean;

  useConsole?: boolean;

  useMouse?: boolean;

  useThread?: boolean;

}
