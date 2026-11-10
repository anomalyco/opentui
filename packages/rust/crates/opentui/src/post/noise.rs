use std::hash::{BuildHasher, Hasher};

/// A small SplitMix64 generator for effects, seeded per instance so tests can repeat a sequence.
#[derive(Clone, Debug)]
pub(crate) struct Rng(u64);

impl Rng {
    pub fn new(seed: u64) -> Self {
        Self(seed)
    }

    /// A generator seeded from the standard library's per-process random keys.
    pub fn random() -> Self {
        let mut hasher = std::collections::hash_map::RandomState::new().build_hasher();
        hasher.write_u64(0x6f70_656e_7475_6921);
        Self(hasher.finish())
    }

    pub fn next_u64(&mut self) -> u64 {
        self.0 = self.0.wrapping_add(0x9e37_79b9_7f4a_7c15);
        let mut z = self.0;
        z = (z ^ (z >> 30)).wrapping_mul(0xbf58_476d_1ce4_e5b9);
        z = (z ^ (z >> 27)).wrapping_mul(0x94d0_49bb_1331_11eb);
        z ^ (z >> 31)
    }

    /// A number in `[0, 1)`, like JavaScript's `Math.random`.
    pub fn next_f64(&mut self) -> f64 {
        (self.next_u64() >> 11) as f64 / (1u64 << 53) as f64
    }
}

/// Core's 3D Perlin noise: a shuffled permutation table and twelve gradient directions.
#[derive(Clone, Debug)]
pub(crate) struct Perlin {
    perm: [u8; 512],
}

const GRADIENTS: [[f64; 3]; 12] = [
    [1.0, 1.0, 0.0],
    [-1.0, 1.0, 0.0],
    [1.0, -1.0, 0.0],
    [-1.0, -1.0, 0.0],
    [1.0, 0.0, 1.0],
    [-1.0, 0.0, 1.0],
    [1.0, 0.0, -1.0],
    [-1.0, 0.0, -1.0],
    [0.0, 1.0, 1.0],
    [0.0, -1.0, 1.0],
    [0.0, 1.0, -1.0],
    [0.0, -1.0, -1.0],
];

impl Perlin {
    /// Shuffles the table with `rng`, drawing numbers in the order Core's constructor does.
    pub fn new(rng: &mut Rng) -> Self {
        let mut table: [u8; 256] = std::array::from_fn(|index| index as u8);
        for index in (1..256).rev() {
            let other = (rng.next_f64() * (index + 1) as f64).floor() as usize;
            table.swap(index, other);
        }
        Self { perm: std::array::from_fn(|index| table[index & 255]) }
    }

    fn fade(t: f64) -> f64 {
        t * t * t * (t * (t * 6.0 - 15.0) + 10.0)
    }

    fn mix(a: f64, b: f64, t: f64) -> f64 {
        a + (b - a) * t
    }

    fn dot(&self, hash: usize, x: f64, y: f64, z: f64) -> f64 {
        let gradient = GRADIENTS[usize::from(self.perm[hash]) % 12];
        gradient[0] * x + gradient[1] * y + gradient[2] * z
    }

    /// Noise at a point, from about -1 to 1.
    pub fn noise3d(&self, x: f64, y: f64, z: f64) -> f64 {
        let (fx, fy, fz) = (x.floor(), y.floor(), z.floor());
        // Core masks with `& 255` after converting to a 32-bit integer.
        let cell = |value: f64| (value as i64 as i32 & 255) as usize;
        let (cx, cy, cz) = (cell(fx), cell(fy), cell(fz));
        let (x, y, z) = (x - fx, y - fy, z - fz);
        let (u, v, w) = (Self::fade(x), Self::fade(y), Self::fade(z));
        let perm = |index: usize| usize::from(self.perm[index]);
        let a = perm(cx) + cy;
        let aa = perm(a) + cz;
        let ab = perm(a + 1) + cz;
        let b = perm(cx + 1) + cy;
        let ba = perm(b) + cz;
        let bb = perm(b + 1) + cz;
        Self::mix(
            Self::mix(
                Self::mix(self.dot(aa, x, y, z), self.dot(ba, x - 1.0, y, z), u),
                Self::mix(self.dot(ab, x, y - 1.0, z), self.dot(bb, x - 1.0, y - 1.0, z), u),
                v,
            ),
            Self::mix(
                Self::mix(self.dot(aa + 1, x, y, z - 1.0), self.dot(ba + 1, x - 1.0, y, z - 1.0), u),
                Self::mix(self.dot(ab + 1, x, y - 1.0, z - 1.0), self.dot(bb + 1, x - 1.0, y - 1.0, z - 1.0), u),
                v,
            ),
            w,
        )
    }

    /// Fractal noise: `octaves` layers at doubling frequency and halving amplitude, normalized to `[0, 1]`.
    /// `point(frequency)` gives the coordinates of each layer.
    pub fn fractal(&self, octaves: u32, mut point: impl FnMut(f64) -> (f64, f64, f64)) -> f64 {
        let (mut value, mut amplitude, mut frequency, mut total) = (0.0, 1.0, 1.0, 0.0);
        for _ in 0..octaves {
            let (x, y, z) = point(frequency);
            value += self.noise3d(x, y, z) * amplitude;
            total += amplitude;
            amplitude *= 0.5;
            frequency *= 2.0;
        }
        (value / total + 1.0) * 0.5
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn numbers_stay_in_range_and_repeat_per_seed() {
        let mut first = Rng::new(7);
        let mut second = Rng::new(7);
        for _ in 0..1000 {
            let value = first.next_f64();
            assert!((0.0..1.0).contains(&value));
            assert_eq!(value, second.next_f64());
        }
    }

    #[test]
    fn noise_is_zero_on_lattice_points_and_bounded() {
        let noise = Perlin::new(&mut Rng::new(1));
        assert_eq!(noise.noise3d(3.0, 4.0, 5.0), 0.0);
        for step in 0..500 {
            let t = f64::from(step) * 0.137;
            assert!(noise.noise3d(t, t * 0.5, -t).abs() <= 1.5);
        }
    }
}
