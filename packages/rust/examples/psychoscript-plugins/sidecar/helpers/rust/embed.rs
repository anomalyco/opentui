/// A stand-in for a CPU-bound embedding: 256 FNV-1a hashes of the text's UTF-8 bytes, one per seed, mapped to
/// [-1, 1) and L2-normalized. `helpers/bun/helper.ts` computes the same numbers, bit for bit.
pub fn embed(text: &str) -> Vec<f64> {
    let v: Vec<f64> = (0..256u32)
        .map(|i| {
            let seed = 0x811c_9dc5 ^ i.wrapping_mul(0x9e37_79b9);
            let h = text.bytes().fold(seed, |h, b| (h ^ b as u32).wrapping_mul(0x0100_0193));
            h as f64 / 4294967296.0 * 2.0 - 1.0
        })
        .collect();
    let norm = v.iter().map(|x| x * x).sum::<f64>().sqrt();
    v.into_iter().map(|x| x / norm).collect()
}
