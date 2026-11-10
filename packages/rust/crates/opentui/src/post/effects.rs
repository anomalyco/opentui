use super::noise::{Perlin, Rng};
use super::{Channels, ColorMatrix, Filter, Surface, channel, is_cluster, is_pooled, set_rgb};
use std::time::Duration;

/// Fades red, green, and blue toward black by each cell's weight, keeping alpha.
const BLACKEN: ColorMatrix = ColorMatrix::new([[0.0; 4], [0.0; 4], [0.0; 4], [0.0, 0.0, 0.0, 1.0]]);

fn milliseconds(elapsed: Duration) -> f64 {
    elapsed.as_secs_f64() * 1000.0
}

/// Darkens cells toward the corners. Core's `VignetteEffect`; runs as one native color matrix.
///
/// The cells of one grapheme run, such as a word in a complex script, share one level, because terminals may shape
/// text differently across a style change.
#[derive(Clone, Debug, PartialEq)]
pub struct Vignette {
    /// How dark the corners get, from 0 (no change) to 1 (black).
    pub strength: f64,
    key: Option<(u32, u32, u64)>,
    levels: Vec<f32>,
    weights: Vec<f32>,
}

impl Vignette {
    pub fn new(strength: f64) -> Self {
        Self { strength, key: None, levels: Vec::new(), weights: Vec::new() }
    }

    fn compute(&mut self, width: u32, height: u32, strength: f64) {
        let (center_x, center_y) = (f64::from(width) / 2.0, f64::from(height) / 2.0);
        let reach = center_x * center_x + center_y * center_y;
        let reach = if reach == 0.0 { 1.0 } else { reach };
        self.levels.clear();
        for y in 0..height {
            let dy = f64::from(y) - center_y;
            for x in 0..width {
                let dx = f64::from(x) - center_x;
                let level = ((dx * dx + dy * dy) / reach).min(1.0);
                self.levels.push((level * strength) as f32);
            }
        }
        self.key = Some((width, height, strength.to_bits()));
    }
}

impl Default for Vignette {
    /// Core's default strength, 0.5.
    fn default() -> Self {
        Self::new(0.5)
    }
}

impl Filter for Vignette {
    fn apply(&mut self, surface: &mut Surface<'_>, _elapsed: Duration) {
        let strength = self.strength.max(0.0);
        let (width, height) = (surface.width(), surface.height());
        if self.key != Some((width, height, strength.to_bits())) {
            self.compute(width, height, strength);
        }
        self.weights.clear();
        self.weights.extend_from_slice(&self.levels);
        if let Some((planes, area)) = surface.planes() {
            for y in 0..area.height as usize {
                let row = (area.y as usize + y) * planes.width as usize + area.x as usize;
                let mut x = 0;
                while x < area.width as usize {
                    if !is_cluster(planes.chars[row + x]) {
                        x += 1;
                        continue;
                    }
                    let start = x;
                    while x < area.width as usize && is_cluster(planes.chars[row + x]) {
                        x += 1;
                    }
                    let level = self.levels[y * width as usize + start + (x - start) / 2];
                    self.weights[y * width as usize + start..y * width as usize + x].fill(level);
                }
            }
        }
        let weights = &self.weights;
        surface.color_matrix_weighted(&BLACKEN, |x, y| weights[(y * width + x) as usize]);
    }
}

#[derive(Clone, Copy, Debug, PartialEq)]
enum Glitch {
    Shift(i64),
    Flip,
    Color,
}

/// Animated glitches: for a moment, a few rows shift sideways, flip, or turn into random colors. Core's
/// `DistortionEffect`.
///
/// Rows holding pooled graphemes (text outside ASCII) or images keep their cells in place: moving pooled cells
/// through the frame's planes could split a wide grapheme from its continuation cells. Their colors can still glitch.
#[derive(Clone, Debug)]
pub struct Distortion {
    /// How often a burst of glitches starts, per second without a burst.
    pub glitch_chance_per_second: f64,
    /// The most rows one burst glitches.
    pub max_glitch_lines: u32,
    pub min_glitch_duration: Duration,
    pub max_glitch_duration: Duration,
    /// The farthest a row shifts, in cells.
    pub max_shift_amount: u32,
    /// Of the rows that do not change color, the share that shift instead of flipping.
    pub shift_flip_ratio: f64,
    /// The share of glitched rows that turn into random colors.
    pub color_glitch_chance: f64,
    since: f64,
    duration: f64,
    glitches: Vec<(u32, Glitch)>,
    row: Vec<(u32, u32, [u16; 4], [u16; 4])>,
    rng: Rng,
}

impl Distortion {
    pub fn new() -> Self {
        Self {
            glitch_chance_per_second: 0.5,
            max_glitch_lines: 3,
            min_glitch_duration: Duration::from_millis(50),
            max_glitch_duration: Duration::from_millis(200),
            max_shift_amount: 10,
            shift_flip_ratio: 0.6,
            color_glitch_chance: 0.2,
            since: 0.0,
            duration: 0.0,
            glitches: Vec::new(),
            row: Vec::new(),
            rng: Rng::random(),
        }
    }

    /// Seeds the random numbers, so the same seed gives the same glitches.
    pub fn seed(mut self, seed: u64) -> Self {
        self.rng = Rng::new(seed);
        self
    }

    /// Whether a burst of glitches is showing.
    pub fn is_glitching(&self) -> bool {
        !self.glitches.is_empty()
    }

    fn start(&mut self, height: u32) {
        let rng = &mut self.rng;
        self.since = 0.0;
        let (min, max) = (self.min_glitch_duration.as_secs_f64(), self.max_glitch_duration.as_secs_f64());
        self.duration = min + rng.next_f64() * (max - min);
        let count = 1 + (rng.next_f64() * f64::from(self.max_glitch_lines)).floor() as u32;
        for _ in 0..count {
            let y = (rng.next_f64() * f64::from(height)).floor() as u32;
            let roll = rng.next_f64();
            let glitch = if roll < self.color_glitch_chance {
                Glitch::Color
            } else if (roll - self.color_glitch_chance) / (1.0 - self.color_glitch_chance) < self.shift_flip_ratio {
                let amount = ((rng.next_f64() - 0.5) * 2.0 * f64::from(self.max_shift_amount)).floor();
                Glitch::Shift(amount as i64)
            } else {
                Glitch::Flip
            };
            if !self.glitches.iter().any(|&(row, _)| row == y) {
                self.glitches.push((y, glitch));
            }
        }
    }

    /// Core's color glitch for one cell: random, single-channel, or high-contrast colors.
    fn glitch_colors(rng: &mut Rng) -> ([f64; 3], [f64; 3]) {
        let mode = rng.next_f64();
        if mode < 0.33 {
            let fg = [rng.next_f64(), rng.next_f64(), rng.next_f64()];
            return (fg, [rng.next_f64(), rng.next_f64(), rng.next_f64()]);
        }
        if mode < 0.66 {
            let emphasis = rng.next_f64();
            let fg = if emphasis < 0.25 {
                [rng.next_f64(), 0.0, 0.0]
            } else if emphasis < 0.5 {
                [0.0, rng.next_f64(), 0.0]
            } else if emphasis < 0.75 {
                [0.0, 0.0, rng.next_f64()]
            } else {
                let roll = rng.next_f64();
                if roll < 0.33 {
                    [1.0, 0.0, 1.0]
                } else if roll < 0.66 {
                    [0.0, 1.0, 1.0]
                } else {
                    [1.0, 1.0, 0.0]
                }
            };
            let bg = if rng.next_f64() < 0.5 {
                fg.map(|value| 1.0 - value)
            } else {
                fg.map(|value| value * (rng.next_f64() * 0.5 + 0.2))
            };
            return (fg, bg);
        }
        let fg = [0; 3].map(|_| if rng.next_f64() > 0.5 { 1.0 } else { 0.0 });
        (fg, fg.map(|value| 1.0 - value))
    }
}

impl Default for Distortion {
    /// Core's defaults: half a burst per second, up to 3 rows for 50 to 200 ms, shifts of up to 10 cells.
    fn default() -> Self {
        Self::new()
    }
}

impl Filter for Distortion {
    fn apply(&mut self, surface: &mut Surface<'_>, elapsed: Duration) {
        let seconds = elapsed.as_secs_f64();
        self.since += seconds;
        if !self.glitches.is_empty() && self.since >= self.duration {
            self.glitches.clear();
            self.duration = 0.0;
        }
        if self.glitches.is_empty() && self.rng.next_f64() < self.glitch_chance_per_second * seconds {
            self.start(surface.height());
        }
        if self.glitches.is_empty() {
            return;
        }
        let Some((planes, area)) = surface.planes() else { return };
        let width = area.width as usize;
        for &(y, glitch) in &self.glitches {
            if y >= area.height {
                continue;
            }
            let start = (area.y + y) as usize * planes.width as usize + area.x as usize;
            match glitch {
                Glitch::Shift(_) | Glitch::Flip => {
                    if width == 0 || planes.chars[start..start + width].iter().any(|&raw| is_pooled(raw)) {
                        continue;
                    }
                    self.row.clear();
                    for x in start..start + width {
                        let color = |plane: &[u16]| -> [u16; 4] { plane[x * 4..x * 4 + 4].try_into().unwrap() };
                        self.row.push((planes.chars[x], planes.attributes[x], color(planes.fg), color(planes.bg)));
                    }
                    for x in 0..width {
                        let source = match glitch {
                            Glitch::Shift(amount) => (x as i64 - amount).rem_euclid(width as i64) as usize,
                            _ => width - 1 - x,
                        };
                        let (character, attributes, fg, bg) = self.row[source];
                        let target = start + x;
                        planes.chars[target] = character;
                        planes.attributes[target] = attributes;
                        planes.fg[target * 4..target * 4 + 4].copy_from_slice(&fg);
                        planes.bg[target * 4..target * 4 + 4].copy_from_slice(&bg);
                    }
                }
                Glitch::Color => {
                    let rng = &mut self.rng;
                    let first = (rng.next_f64() * width as f64).floor() as usize;
                    let room = width - first.min(width);
                    let mut length = (rng.next_f64() * room as f64).floor() as usize + 1;
                    if rng.next_f64() < 0.2 {
                        length = (rng.next_f64() * (width as f64 / 4.0)).floor() as usize + 1;
                    }
                    for x in first..(first + length.min(room)).min(width) {
                        let (fg, bg) = Self::glitch_colors(rng);
                        set_rgb(planes.fg, start + x, fg[0], fg[1], fg[2]);
                        set_rgb(planes.bg, start + x, bg[0], bg[1], bg[2]);
                    }
                }
            }
        }
    }

    fn animated(&self) -> bool {
        true
    }
}

/// Animated cloud shadows drifting over the background, from fractal Perlin noise. Core's `CloudsEffect`; runs as
/// one native color matrix.
#[derive(Clone, Debug)]
pub struct Clouds {
    /// The noise's scale: smaller values give larger clouds. At least 0.001.
    pub scale: f64,
    /// How fast the clouds drift and change, in noise units per millisecond, as in Core.
    pub speed: f64,
    /// How much of the sky is cloud, from 0 to 1.
    pub density: f64,
    /// How dark the thickest clouds get, from 0 to 1.
    pub darkness: f64,
    time: f64,
    noise: Perlin,
}

impl Clouds {
    pub fn new(scale: f64, speed: f64, density: f64, darkness: f64) -> Self {
        Self { scale, speed, density, darkness, time: 0.0, noise: Perlin::new(&mut Rng::random()) }
    }

    /// Seeds the noise, so the same seed gives the same clouds.
    pub fn seed(mut self, seed: u64) -> Self {
        self.noise = Perlin::new(&mut Rng::new(seed));
        self
    }
}

impl Default for Clouds {
    /// Core's defaults (scale 0.02, density 0.6, darkness 0.7), except a speed of 0.001: Core's default of 0.5 moves
    /// the clouds several noise cells per frame. Core's shader demo uses 0.001 too.
    fn default() -> Self {
        Self::new(0.02, 0.001, 0.6, 0.7)
    }
}

impl Filter for Clouds {
    fn apply(&mut self, surface: &mut Surface<'_>, elapsed: Duration) {
        let (scale, speed) = (self.scale.max(0.001), self.speed.max(0.0));
        let (density, darkness) = (self.density.clamp(0.0, 1.0), self.darkness.clamp(0.0, 1.0));
        self.time += milliseconds(elapsed) * speed;
        let (time, noise) = (self.time, &self.noise);
        let matrix = BLACKEN.channels(Channels::Background);
        surface.color_matrix_weighted(&matrix, |x, y| {
            let (x, y) = (f64::from(x), f64::from(y));
            let value = noise.fractal(4, |frequency| {
                ((x * scale * frequency + time) * 0.5, y * scale * frequency * 0.5, time * 0.3)
            });
            ((value - (1.0 - density)).max(0.0) * darkness) as f32
        });
    }

    fn animated(&self) -> bool {
        true
    }
}

/// Animated flames rising from the bottom edge into the background, from fractal Perlin noise. Core's
/// `FlamesEffect`, with the flames at the bottom as Core documents; Core's code puts them at the top.
#[derive(Clone, Debug)]
pub struct Flames {
    /// The noise's scale: smaller values give larger flames. At least 0.001.
    pub scale: f64,
    /// How fast the flames move and flicker, in noise units per millisecond, as in Core.
    pub speed: f64,
    /// The flames' brightness, from 0 to 1.
    pub intensity: f64,
    time: f64,
    noise: Perlin,
}

impl Flames {
    pub fn new(scale: f64, speed: f64, intensity: f64) -> Self {
        Self { scale, speed, intensity, time: 0.0, noise: Perlin::new(&mut Rng::random()) }
    }

    /// Seeds the noise, so the same seed gives the same flames.
    pub fn seed(mut self, seed: u64) -> Self {
        self.noise = Perlin::new(&mut Rng::new(seed));
        self
    }
}

impl Default for Flames {
    /// Core's defaults: scale 0.03, speed 0.02, intensity 0.8.
    fn default() -> Self {
        Self::new(0.03, 0.02, 0.8)
    }
}

impl Filter for Flames {
    fn apply(&mut self, surface: &mut Surface<'_>, elapsed: Duration) {
        let (scale, speed, intensity) = (self.scale.max(0.001), self.speed.max(0.0), self.intensity.clamp(0.0, 1.0));
        self.time += milliseconds(elapsed) * speed;
        let time = self.time;
        let Some((planes, area)) = surface.planes() else { return };
        let height = f64::from(area.height);
        for y in 0..area.height {
            // Strongest on the bottom row, fading toward the top.
            let height_factor = f64::from(y + 1) / height;
            let row = f64::from(area.height - y);
            for x in 0..area.width {
                let column = f64::from(x);
                let value = self.noise.fractal(3, |frequency| {
                    ((column * scale * frequency + time) * 0.5, row * scale * frequency * 2.0 * 0.5, time * 2.0)
                });
                let flame = value * height_factor * intensity;
                if flame <= 0.0 {
                    continue;
                }
                let [r, g, b] = if flame > 0.7 {
                    [1.0, 1.0, 0.3 + (flame - 0.7) * 2.3]
                } else if flame > 0.4 {
                    [1.0, 0.5 + (flame - 0.4) * 1.67, 0.0]
                } else {
                    [0.3 + flame * 1.75, flame * 0.5, 0.0]
                };
                let index = (area.y + y) as usize * planes.width as usize + (area.x + x) as usize;
                let base = index * 4;
                let r = channel(planes.bg, base).max(r * flame);
                let g = channel(planes.bg, base + 1).max(g * flame);
                let b = channel(planes.bg, base + 2).max(b * flame);
                set_rgb(planes.bg, index, r, g, b);
            }
        }
    }

    fn animated(&self) -> bool {
        true
    }
}

/// A bright horizontal bar that rolls slowly down the area, like an old CRT's. Core's `CRTRollingBarEffect`; runs
/// as one native color matrix.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct CrtRollingBar {
    /// Rows per second.
    pub speed: f64,
    /// The bar's height as a share of the area's, from 0.01 to 0.5.
    pub height: f64,
    /// How much the bar brightens colors at its center: 0.3 multiplies them by 1.3.
    pub intensity: f64,
    /// The soft edge on each side, as a share of the bar's height, from 0 to 1.
    pub fade_distance: f64,
    position: f64,
}

impl CrtRollingBar {
    pub fn new(speed: f64, height: f64, intensity: f64, fade_distance: f64) -> Self {
        Self { speed, height, intensity, fade_distance, position: 0.0 }
    }
}

impl Default for CrtRollingBar {
    /// Core's defaults: speed 0.5, height 0.15, intensity 0.3, fade distance 0.3.
    fn default() -> Self {
        Self::new(0.5, 0.15, 0.3, 0.3)
    }
}

impl Filter for CrtRollingBar {
    fn apply(&mut self, surface: &mut Surface<'_>, elapsed: Duration) {
        let bar_share = self.height.clamp(0.01, 0.5);
        let intensity = self.intensity.clamp(0.0, 1.0);
        let fade = self.fade_distance.clamp(0.0, 1.0);
        let height = f64::from(surface.height());
        if height == 0.0 {
            return;
        }
        self.position = (self.position + elapsed.as_secs_f64() * self.speed) % (height + bar_share * height * 2.0);
        let bar = bar_share * height;
        let total = bar + fade * bar * 2.0;
        let center = self.position - total / 2.0 + bar / 2.0;
        let matrix = ColorMatrix::scale((1.0 + intensity) as f32);
        surface.color_matrix_weighted(&matrix, |_, y| {
            let distance = (f64::from(y) - center).abs();
            let factor = if distance <= total / 2.0 {
                (distance / (total / 2.0) * std::f64::consts::PI / 2.0).cos()
            } else {
                0.0
            };
            if factor > 0.001 { factor as f32 } else { 0.0 }
        });
    }

    fn animated(&self) -> bool {
        true
    }
}

/// Cycles white text through a diagonal rainbow. Text whose red, green, and blue are all at least 90% counts as
/// white. Core's `RainbowTextEffect`.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct RainbowText {
    /// How fast the colors move, as in Core: the spectrum cycles `100 * speed` times per second.
    pub speed: f64,
    /// From 0 to 1.
    pub saturation: f64,
    /// Brightness, from 0 to 1.
    pub value: f64,
    /// How many rainbows fit across the area, at least 0.1.
    pub repeats: f64,
    time: f64,
}

impl RainbowText {
    pub fn new(speed: f64, saturation: f64, value: f64, repeats: f64) -> Self {
        Self { speed, saturation, value, repeats, time: 0.0 }
    }
}

impl Default for RainbowText {
    /// Core's defaults: speed 0.01, full saturation and value, 3 repeats.
    fn default() -> Self {
        Self::new(0.01, 1.0, 1.0, 3.0)
    }
}

/// HSV with all three from 0 to 1, to RGB.
fn hsv_to_rgb(hue: f64, saturation: f64, value: f64) -> [f64; 3] {
    let sector = (hue * 6.0).floor();
    let fraction = hue * 6.0 - sector;
    let p = value * (1.0 - saturation);
    let q = value * (1.0 - fraction * saturation);
    let t = value * (1.0 - (1.0 - fraction) * saturation);
    match sector as i64 % 6 {
        0 => [value, t, p],
        1 => [q, value, p],
        2 => [p, value, t],
        3 => [p, q, value],
        4 => [t, p, value],
        5 => [value, p, q],
        _ => [0.0; 3],
    }
}

impl Filter for RainbowText {
    fn apply(&mut self, surface: &mut Surface<'_>, elapsed: Duration) {
        let speed = self.speed.max(0.0);
        let (saturation, value) = (self.saturation.clamp(0.0, 1.0), self.value.clamp(0.0, 1.0));
        let repeats = self.repeats.max(0.1);
        self.time += milliseconds(elapsed) * speed;
        let Some((planes, area)) = surface.planes() else { return };
        let angle = 25.0 * std::f64::consts::PI / 180.0;
        let (cos, sin) = (angle.cos(), angle.sin());
        let reach = f64::from(area.width) * cos + f64::from(area.height) * sin;
        for y in 0..area.height {
            for x in 0..area.width {
                let index = (area.y + y) as usize * planes.width as usize + (area.x + x) as usize;
                let base = index * 4;
                let white = (0..3).all(|offset| channel(planes.fg, base + offset) >= 0.9);
                if white {
                    let projection = f64::from(x) * cos + f64::from(y) * sin;
                    let hue = (projection / reach * repeats + self.time * 0.1) % 1.0;
                    let [r, g, b] = hsv_to_rgb(hue, saturation, value);
                    set_rgb(planes.fg, index, r, g, b);
                }
            }
        }
    }

    fn animated(&self) -> bool {
        true
    }
}
