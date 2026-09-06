use crate::support::OutputStats;
use std::time::Duration;

/// Measures completed native presentations, not loop iterations or terminal display latency.
pub struct Fps {
    pub rate: f64,
    pub frames: u64,
    pub bytes_per_second: f64,
    pub total_bytes: u64,
    pub output: OutputStats,
    pub timing: Timing,
    pub unpresented: u64,
    window_start: Duration,
    window_frames: u64,
    window_bytes: u64,
    last_frame: Duration,
    last_output: Duration,
    samples: [f64; 120],
    sample_count: usize,
    next: usize,
}

#[derive(Clone, Copy, Debug, Default)]
pub struct Timing {
    pub update: Duration,
    pub render: Duration,
    pub output: Duration,
}

impl Fps {
    pub fn new(now: Duration, frames: u64) -> Self {
        Self {
            rate: 0.0,
            frames,
            bytes_per_second: 0.0,
            total_bytes: 0,
            output: OutputStats::default(),
            timing: Timing::default(),
            unpresented: 0,
            window_start: now,
            window_frames: 0,
            window_bytes: 0,
            last_frame: now,
            last_output: now,
            samples: [0.0; 120],
            sample_count: 0,
            next: 0,
        }
    }

    pub fn record(&mut self, now: Duration, frames: u64, timing: Timing, output: OutputStats) {
        let completed = frames.saturating_sub(self.frames);
        self.frames = frames;
        self.output = output;
        self.total_bytes = self.total_bytes.saturating_add(output.bytes);
        self.window_bytes = self.window_bytes.saturating_add(output.bytes);
        self.window_frames = self.window_frames.saturating_add(completed);
        if output.bytes != 0 {
            self.last_output = now;
        }
        if completed != 0 {
            self.last_frame = now;
            self.timing = timing;
            self.samples[self.next] = (timing.update + timing.render + timing.output).as_secs_f64() * 1000.0;
            self.next = (self.next + 1) % self.samples.len();
            self.sample_count = (self.sample_count + 1).min(self.samples.len());
        } else {
            self.unpresented = self.unpresented.saturating_add(1);
        }
        self.advance(now);
    }

    /// Ages rates without submitting a frame or counting idle polls as attempts.
    pub fn advance(&mut self, now: Duration) {
        let elapsed = now.saturating_sub(self.window_start);
        if elapsed >= Duration::from_secs(1) {
            self.rate = self.window_frames as f64 / elapsed.as_secs_f64();
            self.bytes_per_second = self.window_bytes as f64 / elapsed.as_secs_f64();
            self.window_start = now;
            self.window_frames = 0;
            self.window_bytes = 0;
        }
        if now.saturating_sub(self.last_frame) >= Duration::from_secs(1) {
            self.rate = 0.0;
        }
        if now.saturating_sub(self.last_output) >= Duration::from_secs(1) {
            self.bytes_per_second = 0.0;
        }
    }

    pub fn mean_ms(&self) -> f64 {
        self.samples[..self.sample_count].iter().sum::<f64>() / self.sample_count.max(1) as f64
    }

    pub fn p95_ms(&self) -> f64 {
        if self.sample_count == 0 {
            return 0.0;
        }
        let mut sorted = self.samples;
        sorted[..self.sample_count].sort_by(f64::total_cmp);
        sorted[(self.sample_count * 95).div_ceil(100) - 1]
    }

    pub fn history(&self, columns: usize, budget_ms: f64) -> String {
        const SHADES: &[u8] = b".,:-=+*#%@";
        let count = columns.min(self.sample_count);
        let mut result = String::with_capacity(count);
        for offset in 0..count {
            let index = (self.next + self.samples.len() - count + offset) % self.samples.len();
            let shade = ((self.samples[index] / budget_ms * 9.0) as usize).min(9);
            result.push(SHADES[shade] as char);
        }
        result
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn fps_counts_completed_frames_and_elapsed_wall_time() {
        let mut stats = Fps::new(Duration::ZERO, 10);
        let work = Timing { render: Duration::from_millis(2), ..Default::default() };
        stats.record(Duration::from_millis(500), 25, work, OutputStats { bytes: 100, ..Default::default() });
        stats.record(Duration::from_secs(1), 40, work, OutputStats { bytes: 200, ..Default::default() });
        assert_eq!(stats.rate, 30.0);
        assert_eq!(stats.bytes_per_second, 300.0);
        assert_eq!(stats.mean_ms(), 2.0);
        stats.record(Duration::from_secs(3), 40, Timing::default(), OutputStats::default());
        assert_eq!(stats.rate, 0.0);
        assert_eq!(stats.unpresented, 1);
        assert_eq!(stats.mean_ms(), 2.0);
    }

    #[test]
    fn work_history_is_bounded_and_percentiles_handle_empty_and_full_windows() {
        let mut stats = Fps::new(Duration::ZERO, 0);
        assert_eq!(stats.p95_ms(), 0.0);
        assert_eq!(stats.history(32, 1.0), "");
        for frame in 1..=240 {
            stats.record(
                Duration::from_millis(frame),
                frame,
                Timing { update: Duration::from_millis(frame), ..Default::default() },
                OutputStats::default(),
            );
        }
        assert_eq!(stats.sample_count, 120);
        assert_eq!(stats.p95_ms(), 234.0);
        assert_eq!(stats.history(usize::MAX, 1.0).len(), 120);
        assert_eq!(stats.history(3, 1.0), "@@@");
    }

    #[test]
    fn idle_time_ages_rates_without_recording_a_frame_attempt() {
        let mut stats = Fps::new(Duration::ZERO, 0);
        stats.record(Duration::from_secs(1), 30, Timing::default(), OutputStats { bytes: 1024, ..Default::default() });
        assert_eq!(stats.rate, 30.0);
        stats.record(
            Duration::from_millis(1250),
            31,
            Timing::default(),
            OutputStats { bytes: 128, ..Default::default() },
        );
        stats.advance(Duration::from_secs(2));
        assert_eq!(stats.rate, 1.0);
        // The preceding bucket is positive, but no frame or bytes arrived for over a second.
        stats.advance(Duration::from_millis(2400));
        assert_eq!(stats.rate, 0.0);
        assert_eq!(stats.bytes_per_second, 0.0);
        assert_eq!(stats.frames, 31);
        assert_eq!(stats.unpresented, 0);
        assert_eq!(stats.sample_count, 2);

        stats.record(Duration::from_secs(3), 31, Timing::default(), OutputStats { bytes: 512, ..Default::default() });
        assert_eq!(stats.rate, 0.0);
        assert_eq!(stats.bytes_per_second, 512.0, "output can advance without a completed frame");
    }
}
