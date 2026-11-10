use super::noise::Rng;
use super::{Channels, ColorMatrix, Filter, Surface, channel, js_round, set_rgb};
use crate::style::Color;
use std::time::Duration;

/// Darkens the background of every `step`th row, starting with the first, like a CRT's scanlines. Text keeps its
/// color. Core's `applyScanlines`; runs as one native color matrix.
///
/// ```no_run
/// # use opentui::prelude::*;
/// # let app = App::new(AppOptions::default())?;
/// app.root().filter(opentui::post::Scanlines::new(0.7, 2));
/// # Ok::<(), opentui::Error>(())
/// ```
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Scanlines {
    /// The factor darkened rows' backgrounds are multiplied by. 1 changes nothing.
    pub strength: f64,
    /// Rows from one scanline to the next. 0 changes nothing.
    pub step: u32,
}

impl Scanlines {
    pub fn new(strength: f64, step: u32) -> Self {
        Self { strength, step }
    }
}

impl Default for Scanlines {
    /// Core's defaults: strength 0.8, every second row.
    fn default() -> Self {
        Self::new(0.8, 2)
    }
}

impl Filter for Scanlines {
    fn apply(&mut self, surface: &mut Surface<'_>, _elapsed: Duration) {
        if self.strength == 1.0 || self.step < 1 {
            return;
        }
        let matrix = ColorMatrix::scale(self.strength as f32).channels(Channels::Background);
        let step = self.step;
        surface.color_matrix_weighted(&matrix, |_, y| if y.is_multiple_of(step) { 1.0 } else { 0.0 });
    }
}

/// Brightens or darkens each cell by a random amount up to `strength`, chosen again every frame. Core's
/// `applyNoise`; runs as one native color matrix with random cell weights.
#[derive(Clone, Debug)]
pub struct Noise {
    /// The largest change, as a fraction of each color: 0.1 scales colors by 0.9 through 1.1.
    pub strength: f64,
    rng: Rng,
}

impl Noise {
    pub fn new(strength: f64) -> Self {
        Self { strength, rng: Rng::random() }
    }

    /// Seeds the random numbers, so the same seed gives the same noise.
    pub fn seed(mut self, seed: u64) -> Self {
        self.rng = Rng::new(seed);
        self
    }
}

impl Default for Noise {
    /// Core's default strength, 0.1.
    fn default() -> Self {
        Self::new(0.1)
    }
}

impl Filter for Noise {
    fn apply(&mut self, surface: &mut Surface<'_>, _elapsed: Duration) {
        if self.strength == 0.0 {
            return;
        }
        let matrix = ColorMatrix::scale((1.0 + self.strength) as f32);
        let rng = &mut self.rng;
        surface.color_matrix_weighted(&matrix, |_, _| ((rng.next_f64() - 0.5) * 2.0) as f32);
    }
}

/// Splits text colors into red and blue fringes that grow toward the edges, like a cheap lens. Core's
/// `applyChromaticAberration`.
#[derive(Clone, Debug, PartialEq)]
pub struct ChromaticAberration {
    /// The fringe's width at the edges, in cells.
    pub strength: f64,
    source: Vec<u16>,
}

impl ChromaticAberration {
    pub fn new(strength: f64) -> Self {
        Self { strength, source: Vec::new() }
    }
}

impl Default for ChromaticAberration {
    /// Core's default strength, 1 cell.
    fn default() -> Self {
        Self::new(1.0)
    }
}

impl Filter for ChromaticAberration {
    fn apply(&mut self, surface: &mut Surface<'_>, _elapsed: Duration) {
        let Some((planes, area)) = surface.planes() else { return };
        let (width, height) = (area.width as usize, area.height as usize);
        let index = |x: usize, y: usize| (area.y as usize + y) * planes.width as usize + area.x as usize + x;
        self.source.clear();
        for y in 0..height {
            let start = index(0, y) * 4;
            self.source.extend_from_slice(&planes.fg[start..start + width * 4]);
        }
        let (center_x, center_y) = (width as f64 / 2.0, height as f64 / 2.0);
        let reach = center_x.max(center_y);
        for y in 0..height {
            for x in 0..width {
                let (dx, dy) = (x as f64 - center_x, y as f64 - center_y);
                let offset = js_round((dx * dx + dy * dy).sqrt() / reach * self.strength);
                let column = |shifted: f64| shifted.clamp(0.0, (width - 1) as f64) as usize;
                let (red, blue) = (column(x as f64 - offset), column(x as f64 + offset));
                let source = |column: usize, channel_index: usize| {
                    channel(&self.source, (y * width + column) * 4 + channel_index)
                };
                let (r, g, b) = (source(red, 0), source(x, 1), source(blue, 2));
                set_rgb(planes.fg, index(x, y), r, g, b);
            }
        }
    }
}

/// Core's ramp from dark to bright.
const ASCII_RAMP: &str = " .'`^\"\",:;Il!i><~+_-?][}{1)(|\\/tfjrxnuvczXYUJCLQ0OZmwqpdbkhao*#MW&8%B@$";

/// Redraws the area as ASCII art: each cell becomes a character from a ramp chosen by its background's brightness,
/// in one text and one background color. Core's `applyAsciiArt`; draws through native packed cells, which clears
/// attributes.
#[derive(Clone, Debug, PartialEq)]
pub struct AsciiArt {
    /// Characters from darkest to brightest. Characters other than printable ASCII draw as blocks.
    pub ramp: String,
    pub fg: Color,
    pub bg: Color,
    chars: Vec<char>,
    picked: Vec<char>,
}

impl AsciiArt {
    pub fn new(ramp: impl Into<String>, fg: Color, bg: Color) -> Self {
        Self { ramp: ramp.into(), fg, bg, chars: Vec::new(), picked: Vec::new() }
    }
}

impl Default for AsciiArt {
    /// Core's ramp, white on black.
    fn default() -> Self {
        Self::new(ASCII_RAMP, Color::rgb(255, 255, 255), Color::rgb(0, 0, 0))
    }
}

impl Filter for AsciiArt {
    fn apply(&mut self, surface: &mut Surface<'_>, _elapsed: Duration) {
        self.chars.clear();
        self.chars.extend(self.ramp.chars());
        if self.chars.is_empty() {
            return;
        }
        let Some((planes, area)) = surface.planes() else { return };
        self.picked.clear();
        for y in 0..area.height as usize {
            for x in 0..area.width as usize {
                let index = ((area.y as usize + y) * planes.width as usize + area.x as usize + x) * 4;
                let luminance = 0.299 * channel(planes.bg, index)
                    + 0.587 * channel(planes.bg, index + 1)
                    + 0.114 * channel(planes.bg, index + 2);
                let slot = ((luminance * self.chars.len() as f64).floor() as usize).min(self.chars.len() - 1);
                self.picked.push(self.chars[slot]);
            }
        }
        let (fg, bg, width) = (self.fg, self.bg, area.width);
        let picked = &self.picked;
        surface.draw_cells(|x, y| (picked.get((y * width + x) as usize).copied().unwrap_or(' '), fg, bg));
    }
}

/// The largest bloom radius, which bounds each bright cell's work.
const BLOOM_RADIUS_MAX: u32 = 16;

/// Spreads light from bright cells onto their neighbors. Core's `BloomEffect`.
#[derive(Clone, Debug, PartialEq)]
pub struct Bloom {
    /// The luminance, from 0 to 1, above which a cell glows.
    pub threshold: f64,
    /// How much light a glowing cell adds to its neighbors.
    pub strength: f64,
    /// How far the light reaches, in cells, at most 16.
    pub radius: u32,
    bright: Vec<(usize, usize, f64)>,
}

impl Bloom {
    pub fn new(threshold: f64, strength: f64, radius: u32) -> Self {
        Self { threshold, strength, radius, bright: Vec::new() }
    }
}

impl Default for Bloom {
    /// Core's defaults: threshold 0.8, strength 0.2, radius 2.
    fn default() -> Self {
        Self::new(0.8, 0.2, 2)
    }
}

impl Filter for Bloom {
    fn apply(&mut self, surface: &mut Surface<'_>, _elapsed: Duration) {
        let threshold = self.threshold.clamp(0.0, 1.0);
        let strength = self.strength.max(0.0);
        let radius = self.radius.min(BLOOM_RADIUS_MAX) as i64;
        if strength <= 0.0 || radius <= 0 {
            return;
        }
        let Some((planes, area)) = surface.planes() else { return };
        let (width, height) = (area.width as usize, area.height as usize);
        let index = |x: usize, y: usize| (area.y as usize + y) * planes.width as usize + area.x as usize + x;
        let luminance = |plane: &[u16], base: usize| {
            0.299 * channel(plane, base) + 0.587 * channel(plane, base + 1) + 0.114 * channel(plane, base + 2)
        };
        self.bright.clear();
        for y in 0..height {
            for x in 0..width {
                let base = index(x, y) * 4;
                let lum = luminance(planes.fg, base).max(luminance(planes.bg, base));
                if lum > threshold {
                    let intensity = (lum - threshold) / (1.0 - threshold + 1e-6);
                    self.bright.push((x, y, intensity.max(0.0)));
                }
            }
        }
        let radius_sq = (radius * radius) as f64;
        for &(x, y, intensity) in &self.bright {
            for ky in -radius..=radius {
                for kx in -radius..=radius {
                    let (sample_x, sample_y) = (x as i64 + kx, y as i64 + ky);
                    if (kx == 0 && ky == 0)
                        || sample_x < 0
                        || sample_y < 0
                        || sample_x >= width as i64
                        || sample_y >= height as i64
                    {
                        continue;
                    }
                    let distance_sq = (kx * kx + ky * ky) as f64;
                    if distance_sq > radius_sq {
                        continue;
                    }
                    let amount = intensity * strength * (1.0 - distance_sq / radius_sq);
                    let target = index(sample_x as usize, sample_y as usize);
                    for plane in [&mut *planes.fg, &mut *planes.bg] {
                        let base = target * 4;
                        let lift = |offset: usize| (channel(plane, base + offset) + amount).min(1.0);
                        let (r, g, b) = (lift(0), lift(1), lift(2));
                        set_rgb(plane, target, r, g, b);
                    }
                }
            }
        }
    }
}
