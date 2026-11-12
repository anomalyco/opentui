//! Shared harness for seeded model tests (markdown-highlight-ssot-models.md, 3.1), as `packages/native/src/tests/
//! model.zig` is for Zig: generate a command list from a seed, run it against the system and its oracle, and on a
//! failure shrink the list (drop chunks of n/2 down to 1, then simplify each command) and print the trace.
//!
//! Environment: `MODEL_SEED=<n>` runs one seed, `MODEL_SEEDS=<n>` sets how many seeds run, `MODEL_SKIP=<property,...>`
//! ignores failures of the named properties.

use std::fmt::Debug;

/// xorshift64*: small, fast, and the same sequence on every platform.
pub struct Rng(u64);

impl Rng {
    pub fn new(seed: u64) -> Self {
        Self(seed.wrapping_mul(0x9e37_79b9_7f4a_7c15) | 1)
    }

    pub fn next(&mut self) -> u64 {
        self.0 ^= self.0 >> 12;
        self.0 ^= self.0 << 25;
        self.0 ^= self.0 >> 27;
        self.0.wrapping_mul(0x2545_f491_4f6c_dd1d)
    }

    /// A number below `n` (which is nonzero).
    pub fn below(&mut self, n: usize) -> usize {
        (self.next() % n as u64) as usize
    }

    pub fn pick<'a, T>(&mut self, items: &'a [T]) -> &'a T {
        &items[self.below(items.len())]
    }
}

/// A property that failed, and the command after which it did.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Failure {
    /// The check that failed: one name per check site.
    pub property: &'static str,
    pub step: usize,
}

pub trait Model {
    type Command: Clone + Debug;

    fn generate(&self, rng: &mut Rng, steps: usize) -> Vec<Self::Command>;

    /// Runs the commands from a fresh start; the first property that fails, if any.
    fn run(&self, commands: &[Self::Command]) -> Option<Failure>;

    /// Smaller versions of a command to try while shrinking.
    fn simplify(&self, _command: &Self::Command) -> Vec<Self::Command> {
        Vec::new()
    }
}

fn environment(key: &str) -> Option<String> {
    std::env::var(key).ok().filter(|value| !value.is_empty())
}

/// Runs `seeds` seeds of `steps` commands (or the environment's), and panics with the shrunk trace of a failure.
pub fn check<M: Model>(model: &M, seeds: u64, steps: usize) {
    let seed_value = environment("MODEL_SEED").map(|text| text.parse::<u64>().expect("MODEL_SEED is a number"));
    let seeds = environment("MODEL_SEEDS").map_or(seeds, |text| text.parse().expect("MODEL_SEEDS is a number"));
    let skip = environment("MODEL_SKIP").unwrap_or_default();
    let range = match seed_value {
        Some(seed) => seed..seed + 1,
        None => 0..seeds,
    };
    for seed in range {
        let commands = model.generate(&mut Rng::new(seed), steps);
        let Some(failure) = model.run(&commands) else { continue };
        if skip.split(',').any(|name| name == failure.property) {
            continue;
        }
        let shrunk = shrink(model, commands, failure.property);
        let trace: Vec<String> = shrunk.iter().map(|command| format!("  {command:?}")).collect();
        panic!(
            "model failure: seed {seed}, property {}, shrunk to {} commands:\n{}",
            failure.property,
            shrunk.len(),
            trace.join("\n")
        );
    }
}

/// Runs every sequence of `depth` commands from `alphabet` (each shorter one is a prefix: `run` checks after every
/// command), and panics with the commands up to the first failure.
pub fn check_exhaustive<M: Model>(model: &M, alphabet: &[M::Command], depth: u32) {
    for sequence in 0..alphabet.len().pow(depth) {
        let mut rest = sequence;
        let commands: Vec<M::Command> = (0..depth)
            .map(|_| {
                let command = alphabet[rest % alphabet.len()].clone();
                rest /= alphabet.len();
                command
            })
            .collect();
        if let Some(failure) = model.run(&commands) {
            let trace: Vec<String> = commands[..=failure.step].iter().map(|command| format!("  {command:?}")).collect();
            panic!("model failure: property {}, after:\n{}", failure.property, trace.join("\n"));
        }
    }
}

/// The shrinker keeps a candidate only when it fails the same property: a model names each check site with its own
/// property, so a candidate that fails another check (another bug) is not taken for this one.
fn fails_with<M: Model>(model: &M, commands: &[M::Command], property: &str) -> bool {
    model.run(commands).is_some_and(|failure| failure.property == property)
}

fn shrink<M: Model>(model: &M, initial: Vec<M::Command>, property: &str) -> Vec<M::Command> {
    let mut current = initial;
    let mut chunk = (current.len() / 2).max(1);
    loop {
        let mut start = 0;
        let mut removed_any = false;
        while start < current.len() {
            let end = current.len().min(start + chunk);
            let candidate: Vec<M::Command> = current[..start].iter().chain(&current[end..]).cloned().collect();
            if fails_with(model, &candidate, property) {
                current = candidate;
                removed_any = true;
            } else {
                start = end;
            }
        }
        if chunk == 1 && !removed_any {
            break;
        }
        if !removed_any {
            chunk /= 2;
        }
    }
    // Simplify each command while the failure stays: the first smaller command that keeps it.
    for index in 0..current.len() {
        'simpler: loop {
            for candidate in model.simplify(&current[index]) {
                let saved = std::mem::replace(&mut current[index], candidate);
                if fails_with(model, &current, property) {
                    continue 'simpler;
                }
                current[index] = saved;
            }
            break;
        }
    }
    current
}
