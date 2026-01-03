/**
 * TimelineOptions configuration options
 * 
 * @public
 * @category Configuration
 */
export interface TimelineOptions {
  autoplay?: boolean;

  duration?: number;

  loop?: boolean;

  /**
   * () => void
   */
  onComplete?: any;

  /**
   * () => void
   */
  onPause?: any;

}
