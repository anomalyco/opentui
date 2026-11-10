// Standard sepia transformation matrix (4x4 RGBA with alpha identity)
export const SEPIA_MATRIX = new Float32Array([
  0.393,
  0.769,
  0.189,
  0, // Red output (r->r, g->r, b->r, a->r)
  0.349,
  0.686,
  0.168,
  0, // Green output (r->g, g->g, b->g, a->g)
  0.272,
  0.534,
  0.131,
  0, // Blue output (r->b, g->b, b->b, a->b)
  0,
  0,
  0,
  1, // Alpha output (r->a, g->a, b->a, a->a) - identity
])

/**
 * Colorblindness simulation and compensation filters using color matrix transformations.
 */

// Protanopia (Red-blind) simulation matrix - shows how colors appear to someone with red-blindness
export const PROTANOPIA_SIM_MATRIX = new Float32Array([
  0.567,
  0.433,
  0.0,
  0, // Red output
  0.558,
  0.442,
  0.0,
  0, // Green output
  0.0,
  0.242,
  0.758,
  0, // Blue output
  0,
  0,
  0,
  1, // Alpha output - identity
])

// Deuteranopia (Green-blind) simulation matrix - shows how colors appear to someone with green-blindness
export const DEUTERANOPIA_SIM_MATRIX = new Float32Array([
  0.625,
  0.375,
  0.0,
  0, // Red output
  0.7,
  0.3,
  0.0,
  0, // Green output
  0.0,
  0.3,
  0.7,
  0, // Blue output
  0,
  0,
  0,
  1, // Alpha output - identity
])

// Tritanopia (Blue-blind) simulation matrix - shows how colors appear to someone with blue-blindness
export const TRITANOPIA_SIM_MATRIX = new Float32Array([
  0.95,
  0.05,
  0.0,
  0, // Red output
  0.0,
  0.433,
  0.567,
  0, // Green output
  0.0,
  0.475,
  0.525,
  0, // Blue output
  0,
  0,
  0,
  1, // Alpha output - identity
])

// Achromatopsia (Complete color blindness) - grayscale
export const ACHROMATOPSIA_MATRIX = new Float32Array([
  0.299,
  0.587,
  0.114,
  0, // Red output (luminance)
  0.299,
  0.587,
  0.114,
  0, // Green output (luminance)
  0.299,
  0.587,
  0.114,
  0, // Blue output (luminance)
  0,
  0,
  0,
  1, // Alpha output - identity
])

// Protanopia compensation matrix - shifts colors to make them more distinguishable
export const PROTANOPIA_COMP_MATRIX = new Float32Array([
  1.0,
  0.2,
  0.0,
  0, // Boost red channel
  0.0,
  0.9,
  0.1,
  0, // Adjust green
  0.0,
  0.1,
  0.9,
  0, // Enhance blue
  0,
  0,
  0,
  1, // Alpha output - identity
])

// Deuteranopia compensation matrix - shifts colors to make them more distinguishable
export const DEUTERANOPIA_COMP_MATRIX = new Float32Array([
  0.9,
  0.1,
  0.0,
  0, // Adjust red
  0.2,
  0.8,
  0.0,
  0, // Boost green channel
  0.0,
  0.0,
  1.0,
  0, // Keep blue
  0,
  0,
  0,
  1, // Alpha output - identity
])

// Tritanopia compensation matrix - shifts colors to make them more distinguishable
export const TRITANOPIA_COMP_MATRIX = new Float32Array([
  1.0,
  0.0,
  0.0,
  0, // Keep red
  0.0,
  0.9,
  0.1,
  0, // Adjust green
  0.1,
  0.0,
  0.9,
  0, // Boost blue channel
  0,
  0,
  0,
  1, // Alpha output - identity
])

/**
 * Creative color effect matrices.
 */

// Technicolor effect - enhances reds and greens for a vintage Hollywood look
export const TECHNICOLOR_MATRIX = new Float32Array([
  1.5,
  -0.2,
  -0.3,
  0, // Red output - boosted with reduced green/blue influence
  -0.3,
  1.4,
  -0.1,
  0, // Green output - boosted with reduced red/blue influence
  -0.2,
  -0.2,
  1.4,
  0, // Blue output - slightly boosted
  0,
  0,
  0,
  1, // Alpha output - identity
])

// Solarization effect - partial negative that creates a surreal look
// Inverts blue channel strongly, partially inverts others
export const SOLARIZATION_MATRIX = new Float32Array([
  -0.5,
  0.5,
  0.5,
  0, // Red output - partial negative
  0.5,
  -0.5,
  0.5,
  0, // Green output - partial negative
  0.5,
  0.5,
  -0.5,
  0, // Blue output - partial negative
  0,
  0,
  0,
  1, // Alpha output - identity
])

// Synthwave effect - eliminates green and shifts red toward magenta for that retro neon aesthetic
export const SYNTHWAVE_MATRIX = new Float32Array([
  1.0,
  0.0,
  0.25,
  0, // Red output - full red + some blue = magenta when bright
  0.1,
  0.1,
  0.1,
  0, // Green output - heavily suppressed, minimal contribution
  0.25,
  0.0,
  1.0,
  0, // Blue output - full blue + some red = enhances magenta tones
  0,
  0,
  0,
  1, // Alpha output - identity
])

// Greenscale effect - converts image to monochrome green by mapping luminance to green channel only
export const GREENSCALE_MATRIX = new Float32Array([
  0,
  0,
  0,
  0, // Red output - zeroed out
  0.299,
  0.587,
  0.114,
  0, // Green output - full luminance from all channels
  0,
  0,
  0,
  0, // Blue output - zeroed out
  0,
  0,
  0,
  1, // Alpha output - identity
])

// Grayscale effect - converts image to monochrome gray using luminance weights
export const GRAYSCALE_MATRIX = new Float32Array([
  0.299,
  0.587,
  0.114,
  0, // Red output - luminance from all channels
  0.299,
  0.587,
  0.114,
  0, // Green output - luminance from all channels
  0.299,
  0.587,
  0.114,
  0, // Blue output - luminance from all channels
  0,
  0,
  0,
  1, // Alpha output - identity
])

// Invert effect - inverts all color channels (photographic negative)
export const INVERT_MATRIX = new Float32Array([
  -1,
  0,
  0,
  1, // Red output = 1 - R
  0,
  -1,
  0,
  1, // Green output = 1 - G
  0,
  0,
  -1,
  1, // Blue output = 1 - B
  0,
  0,
  0,
  1, // Alpha output - identity
])
