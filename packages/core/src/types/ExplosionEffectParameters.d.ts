/**
 * ExplosionEffectParameters configuration options
 * 
 * @public
 * @category Configuration
 */
export interface ExplosionEffectParameters {
  angularVelocityMax: Vector3;

  angularVelocityMin: Vector3;

  durationMs: number;

  fadeOut: boolean;

  gravity: number;

  gravityScale: number;

  initialVelocityYBoost: number;

  /**
   * () => NodeMaterial
   */
  materialFactory: any;

  numCols: number;

  numRows: number;

  strength: number;

  strengthVariation: number;

  zVariationStrength: number;

}
