use super::{Filter, Surface};
use crate::style::Color;
use std::time::Duration;

/// Which colors of a cell a [`ColorMatrix`] changes.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Hash)]
pub enum Channels {
    /// Text colors only.
    Foreground,
    /// Background colors only.
    Background,
    /// Both colors.
    #[default]
    Both,
}

impl Channels {
    pub(crate) const fn raw(self) -> u32 {
        match self {
            Self::Foreground => 1,
            Self::Background => 2,
            Self::Both => 3,
        }
    }
}

/// A 4x4 matrix that transforms cell colors, as OpenTUI Core's post-processing matrices do.
///
/// Each row gives one output channel (red, green, blue, alpha) as a weighted sum of the input red, green, blue, and
/// alpha, all from 0 to 1. The result is blended with the original color by [`Self::strength`] and clamped. Native
/// code applies it; as a [`Filter`] it changes a widget's area or the whole screen:
///
/// ```no_run
/// # use opentui::prelude::*;
/// # let app = App::new(AppOptions::default())?;
/// app.root().filter(ColorMatrix::SEPIA.strength(0.6));
/// let panel = View::new(&app).filter(ColorMatrix::GRAYSCALE.channels(Channels::Foreground));
/// # Ok::<(), opentui::Error>(())
/// ```
///
/// The constants are Core's matrices. A transformed cell's colors become RGB colors: palette and terminal-default
/// colors are transformed through their fallback snapshots.
#[derive(Clone, Copy, Debug, PartialEq)]
#[must_use]
pub struct ColorMatrix {
    /// Output red, green, blue, and alpha, each from the input `[red, green, blue, alpha]`.
    pub rows: [[f32; 4]; 4],
    /// How much of the transformed color replaces the original: 0 keeps it, 1 replaces it. Values outside that range
    /// extrapolate.
    pub strength: f32,
    pub channels: Channels,
}

const fn matrix(rows: [[f32; 4]; 4]) -> ColorMatrix {
    ColorMatrix { rows, strength: 1.0, channels: Channels::Both }
}

/// Rows 0 to 2 of a matrix that keeps alpha.
const fn rgb(r: [f32; 4], g: [f32; 4], b: [f32; 4]) -> ColorMatrix {
    matrix([r, g, b, [0.0, 0.0, 0.0, 1.0]])
}

const LUMA: [f32; 4] = [0.299, 0.587, 0.114, 0.0];

impl ColorMatrix {
    /// Leaves colors unchanged.
    pub const IDENTITY: Self = rgb([1.0, 0.0, 0.0, 0.0], [0.0, 1.0, 0.0, 0.0], [0.0, 0.0, 1.0, 0.0]);
    /// The standard sepia tone.
    pub const SEPIA: Self = rgb([0.393, 0.769, 0.189, 0.0], [0.349, 0.686, 0.168, 0.0], [0.272, 0.534, 0.131, 0.0]);
    /// Shows colors as someone without red cones (protanopia) sees them.
    pub const PROTANOPIA_SIMULATION: Self =
        rgb([0.567, 0.433, 0.0, 0.0], [0.558, 0.442, 0.0, 0.0], [0.0, 0.242, 0.758, 0.0]);
    /// Shows colors as someone without green cones (deuteranopia) sees them.
    pub const DEUTERANOPIA_SIMULATION: Self = rgb([0.625, 0.375, 0.0, 0.0], [0.7, 0.3, 0.0, 0.0], [0.0, 0.3, 0.7, 0.0]);
    /// Shows colors as someone without blue cones (tritanopia) sees them.
    pub const TRITANOPIA_SIMULATION: Self =
        rgb([0.95, 0.05, 0.0, 0.0], [0.0, 0.433, 0.567, 0.0], [0.0, 0.475, 0.525, 0.0]);
    /// Shows colors as someone without color vision (achromatopsia) sees them: luminance gray.
    pub const ACHROMATOPSIA: Self = rgb(LUMA, LUMA, LUMA);
    /// Shifts colors so they are easier to tell apart with protanopia.
    pub const PROTANOPIA_COMPENSATION: Self = rgb([1.0, 0.2, 0.0, 0.0], [0.0, 0.9, 0.1, 0.0], [0.0, 0.1, 0.9, 0.0]);
    /// Shifts colors so they are easier to tell apart with deuteranopia.
    pub const DEUTERANOPIA_COMPENSATION: Self = rgb([0.9, 0.1, 0.0, 0.0], [0.2, 0.8, 0.0, 0.0], [0.0, 0.0, 1.0, 0.0]);
    /// Shifts colors so they are easier to tell apart with tritanopia.
    pub const TRITANOPIA_COMPENSATION: Self = rgb([1.0, 0.0, 0.0, 0.0], [0.0, 0.9, 0.1, 0.0], [0.1, 0.0, 0.9, 0.0]);
    /// Boosted reds and greens, for a vintage film look.
    pub const TECHNICOLOR: Self = rgb([1.5, -0.2, -0.3, 0.0], [-0.3, 1.4, -0.1, 0.0], [-0.2, -0.2, 1.4, 0.0]);
    /// A partial negative.
    pub const SOLARIZATION: Self = rgb([-0.5, 0.5, 0.5, 0.0], [0.5, -0.5, 0.5, 0.0], [0.5, 0.5, -0.5, 0.0]);
    /// Suppressed green and magenta-shifted red and blue, for a retro neon look.
    pub const SYNTHWAVE: Self = rgb([1.0, 0.0, 0.25, 0.0], [0.1, 0.1, 0.1, 0.0], [0.25, 0.0, 1.0, 0.0]);
    /// Luminance in the green channel only, like a monochrome green screen.
    pub const GREENSCALE: Self = rgb([0.0; 4], LUMA, [0.0; 4]);
    /// Luminance gray.
    pub const GRAYSCALE: Self = rgb(LUMA, LUMA, LUMA);
    /// A photographic negative of opaque colors: each channel becomes one minus itself.
    pub const INVERT: Self = rgb([-1.0, 0.0, 0.0, 1.0], [0.0, -1.0, 0.0, 1.0], [0.0, 0.0, -1.0, 1.0]);

    /// A matrix from its rows, at full strength on both channels.
    ///
    /// ```
    /// # use opentui::prelude::*;
    /// // Swap red and blue.
    /// let swap = ColorMatrix::new([[0.0, 0.0, 1.0, 0.0], [0.0, 1.0, 0.0, 0.0], [1.0, 0.0, 0.0, 0.0], [0.0, 0.0, 0.0, 1.0]]);
    /// assert_eq!(swap.apply(Color::rgb(10, 20, 30)), Color::rgb(30, 20, 10));
    /// ```
    pub const fn new(rows: [[f32; 4]; 4]) -> Self {
        matrix(rows)
    }

    /// Adds `amount` to each channel of opaque colors: positive brightens, negative darkens. Core's
    /// `applyBrightness`.
    ///
    /// ```
    /// # use opentui::prelude::*;
    /// assert_eq!(ColorMatrix::brightness(0.2).apply(Color::rgb(0, 100, 250)), Color::rgb(51, 151, 255));
    /// ```
    pub const fn brightness(amount: f32) -> Self {
        rgb([1.0, 0.0, 0.0, amount], [0.0, 1.0, 0.0, amount], [0.0, 0.0, 1.0, amount])
    }

    /// Multiplies each channel by `gain`, at least 0. Core's `applyGain`.
    ///
    /// ```
    /// # use opentui::prelude::*;
    /// assert_eq!(ColorMatrix::gain(0.5).apply(Color::rgb(100, 200, 50)), Color::rgb(50, 100, 25));
    /// ```
    pub const fn gain(gain: f32) -> Self {
        Self::scale(if gain > 0.0 { gain } else { 0.0 })
    }

    /// Scales saturation: 0 is luminance gray, 1 leaves colors, and larger values saturate them. Negative values count
    /// as 0. Core's `applySaturation`.
    ///
    /// ```
    /// # use opentui::prelude::*;
    /// assert_eq!(ColorMatrix::saturation(0.0), ColorMatrix::GRAYSCALE);
    /// ```
    pub const fn saturation(saturation: f32) -> Self {
        let s = if saturation > 0.0 { saturation } else { 0.0 };
        let (r, g, b) = (0.299 * (1.0 - s), 0.587 * (1.0 - s), 0.114 * (1.0 - s));
        rgb([r + s, g, b, 0.0], [r, g + s, b, 0.0], [r, g, b + s, 0.0])
    }

    /// Multiplies red, green, and blue by `factor`, without clamping it.
    pub(crate) const fn scale(factor: f32) -> Self {
        rgb([factor, 0.0, 0.0, 0.0], [0.0, factor, 0.0, 0.0], [0.0, 0.0, factor, 0.0])
    }

    /// Sets the strength: 0 keeps the original colors and 1 applies the matrix fully.
    ///
    /// ```
    /// # use opentui::prelude::*;
    /// assert_eq!(ColorMatrix::INVERT.strength(0.5).apply(Color::rgb(0, 0, 0)), Color::rgb(128, 128, 128));
    /// ```
    pub const fn strength(self, strength: f32) -> Self {
        Self { strength, ..self }
    }

    /// Sets which colors change.
    ///
    /// ```
    /// # use opentui::prelude::*;
    /// let dim_backgrounds = ColorMatrix::gain(0.5).channels(Channels::Background);
    /// # let _ = dim_backgrounds;
    /// ```
    pub const fn channels(self, channels: Channels) -> Self {
        Self { channels, ..self }
    }

    /// The matrix as 16 row-major floats, as native code takes it.
    pub(crate) fn flat(&self) -> [f32; 16] {
        let mut flat = [0.0; 16];
        for (index, value) in self.rows.iter().flatten().enumerate() {
            flat[index] = *value;
        }
        flat
    }

    /// Transforms one color at full weight, with the arithmetic native code uses: `f32` channels from 0 to 1,
    /// blended by [`Self::strength`], clamped, and rounded to bytes. The result is an RGB color. [`Self::channels`]
    /// does not apply here.
    ///
    /// ```
    /// # use opentui::prelude::*;
    /// assert_eq!(ColorMatrix::GRAYSCALE.apply(Color::rgb(255, 0, 0)), Color::rgb(76, 76, 76));
    /// ```
    pub fn apply(&self, color: Color) -> Color {
        self.apply_weighted(color, 1.0)
    }

    /// As [`Self::apply`], for a cell whose mask weight is `weight`.
    pub(crate) fn apply_weighted(&self, color: Color, weight: f32) -> Color {
        let input = [color.r, color.g, color.b, color.a].map(|channel| f32::from(channel) / 255.0);
        let strength = weight * self.strength;
        let output = self.rows.map(|row| row[0] * input[0] + row[1] * input[1] + row[2] * input[2] + row[3] * input[3]);
        let [r, g, b, a] = [0, 1, 2, 3].map(|channel| {
            let value = input[channel] + (output[channel] - input[channel]) * strength;
            to_byte(value)
        });
        Color::rgba(r, g, b, a)
    }
}

/// Native code's float-to-byte conversion: non-finite values become 0, others clamp and round half up.
pub(crate) fn to_byte(value: f32) -> u8 {
    if !value.is_finite() {
        return 0;
    }
    let scaled = value.clamp(0.0, 1.0) * 255.0;
    let whole = scaled as u8;
    whole + u8::from(scaled - f32::from(whole) >= 0.5)
}

impl Default for ColorMatrix {
    fn default() -> Self {
        Self::IDENTITY
    }
}

impl Filter for ColorMatrix {
    fn apply(&mut self, surface: &mut Surface<'_>, _elapsed: Duration) {
        surface.color_matrix(self);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn bytes_round_like_native_code() {
        assert_eq!(to_byte(f32::NAN), 0);
        assert_eq!(to_byte(-1.0), 0);
        assert_eq!(to_byte(2.0), 255);
        assert_eq!(to_byte(0.5), 128);
        assert_eq!(to_byte(127.4 / 255.0), 127);
    }

    #[test]
    fn saturation_one_is_the_identity() {
        let rows = ColorMatrix::saturation(1.0).rows;
        for (row, expected) in rows.iter().zip(ColorMatrix::IDENTITY.rows) {
            for (value, expected) in row.iter().zip(expected) {
                assert!((value - expected).abs() < 1e-6);
            }
        }
    }
}
