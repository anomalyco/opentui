/**
 * AnimationOptions configuration options
 * 
 * @public
 * @category Configuration
 */
export interface AnimationOptions {
  alternate?: boolean;

  duration: number;

  ease?: EasingFunctions;

  loop?: any;

  loopDelay?: number;

  /**
   * () => void
   */
  onComplete?: any;

  /**
   * () => void
   */
  onLoop?: any;

  /**
   * () => void
   */
  onStart?: any;

  /**
   * (animation: JSAnimation) => void
   */
  onUpdate?: { namedArgs: { animation: JSAnimation } };

  once?: boolean;

}
