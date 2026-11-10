//! A video player: an MP4 file, or Core's test clip, with its position below.
//!
//! Run with `sh run.sh video`, or `cargo run --example video -- file.mp4` for another file. Space plays and
//! pauses, Left and Right seek 5 s, M mutes, L loops, and Q quits.

use opentui::prelude::*;
use opentui::widget::{VideoEvent, VideoView};
use std::time::Duration;

const CLIP: &str =
    concat!(env!("CARGO_MANIFEST_DIR"), "/../../../core/src/tests/fixtures/video/testsrc-160x90-24fps-2s.mp4");

fn main() -> opentui::Result<()> {
    let path = std::env::args().nth(1).unwrap_or_else(|| CLIP.into());
    let app = App::new(AppOptions::default())?;
    let video = VideoView::new(&app).grow(1.0).autoplay(true);
    let status = Text::new(&app, "").fg(app.theme().muted);
    app.root().add(&video).add(&status);
    let info = video
        .open(&path)
        .map_err(|error| Error::other(format!("{path}: {error}: {}", video.last_error().unwrap_or_default())))?;

    let help = "Space plays · ←/→ seek · M mutes · L loops · Q quits";
    video.on_event({
        let status = status.clone();
        move |_cx, event| {
            let text = match event {
                VideoEvent::Time(time) => {
                    format!(" {:.1} / {:.1} s · {help}", time.as_secs_f64(), info.duration.as_secs_f64())
                }
                VideoEvent::Ended => format!(" ended · {help}"),
                VideoEvent::Error(detail) => format!(" {detail}"),
                _ => return,
            };
            status.set_text(text);
        }
    });
    let (mut muted, mut looping) = (false, false);
    app.on_key(move |cx, key| {
        let time = video.state().map_or(Duration::ZERO, |state| state.current_time);
        if key.matches("q") {
            cx.quit();
        } else if key.matches("space") {
            video.toggle();
        } else if key.matches("left") {
            video.seek(time.saturating_sub(Duration::from_secs(5)));
        } else if key.matches("right") {
            video.seek(time + Duration::from_secs(5));
        } else if key.matches("m") {
            muted = !muted;
            video.muted(muted);
        } else if key.matches("l") {
            looping = !looping;
            video.looping(looping);
        }
    });
    app.run()
}
