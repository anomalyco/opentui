//! What plugins cost the UI thread per frame, and their end-to-end latency, in a real OpenTUI scene.
//!
//! `cargo run --release --example frame -- [frames]`. For 0, 3, 10 and 50 plugins (the `plugins/` sources without
//! `git`, cycled), each frame sends a key event to every plugin and then waits, untimed, until all replied. The timed
//! UI-thread part is: dispatch (queue the event to each worker) + apply (diff the replies into widgets) + render (paint
//! and present the frame on a 120x40 TestApp). End-to-end is dispatch until every plugin's reply is in the proxy.

use opentui::testing::TestApp;
use psychoscript_plugins::{Host, load_dir};
use serde_json::json;
use std::path::PathBuf;
use std::time::{Duration, Instant};

fn main() {
    let frames: usize = std::env::args().nth(1).and_then(|n| n.parse().ok()).unwrap_or(1000);
    let dir = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("plugins");
    let sources: Vec<_> = load_dir(&dir).unwrap().into_iter().filter(|(id, _)| id != "git").collect();
    println!(
        "| plugins | UI dispatch µs p50 / p99 | UI apply µs p50 / p99 | render µs p50 / p99 | UI total µs p50 / p99 | end-to-end µs p50 / p99 |"
    );
    println!("|---:|---:|---:|---:|---:|---:|");
    for count in [0, 3, 10, 50] {
        let plugins = sources
            .iter()
            .cycle()
            .take(count)
            .enumerate()
            .map(|(i, (id, source))| (format!("{id}{i}"), source.clone()))
            .collect();
        let app = TestApp::new(120, 40);
        let host = Host::mount(&app, plugins);
        let settle = || {
            while host.pending() > 0 {
                std::thread::yield_now();
            }
            app.wait_until(Duration::ZERO, || true);
        };
        settle();
        let mut rows: [Vec<f64>; 5] = Default::default();
        for frame in 0..frames + frames / 5 {
            let t0 = Instant::now();
            host.dispatch(json!({ "type": "key", "key": "x" }));
            let t1 = Instant::now();
            while host.pending() > 0 {
                std::thread::yield_now();
            }
            let t2 = Instant::now();
            app.wait_until(Duration::ZERO, || true);
            let t3 = Instant::now();
            app.render();
            let t4 = Instant::now();
            if frame >= frames / 5 {
                let us = |a: Instant, b: Instant| (b - a).as_secs_f64() * 1e6;
                let ui = us(t0, t1) + us(t2, t4);
                for (row, v) in rows.iter_mut().zip([us(t0, t1), us(t2, t3), us(t3, t4), ui, us(t0, t2)]) {
                    row.push(v);
                }
            }
        }
        let cells: Vec<_> = rows
            .iter_mut()
            .map(|v| {
                v.sort_by(f64::total_cmp);
                format!("{:.1} / {:.1}", v[v.len() / 2], v[v.len() * 99 / 100])
            })
            .collect();
        println!("| {count} | {} |", cells.join(" | "));
    }
}
