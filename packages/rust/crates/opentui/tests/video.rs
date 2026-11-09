//! `VideoView` on the clips Core's and native code's video tests play. Playback follows the wall clock, so these tests
//! sleep in real time and tick the app's manual clock as a running app's loop would. A native library built without
//! FFmpeg cannot decode video: each test then prints SKIP and passes.

use opentui::Status;
use opentui::prelude::*;
use opentui::testing::TestApp;
use opentui::widget::{ImageFit, VideoEvent, VideoInfo, VideoView};
use std::cell::RefCell;
use std::path::PathBuf;
use std::rc::Rc;
use std::time::Duration;

/// 160x90, 24 fps, 2 s, with an AAC track.
const WITH_AUDIO: &str = "testsrc-160x90-24fps-2s.mp4";
/// The same without audio, so playback never opens an audio device.
const SILENT: &str = "testsrc-160x90-24fps-2s-video-only.mp4";
/// Switches to 6000x5000 frames, which native code refuses to decode, at 1 s.
const SWITCH: &str = "resolution-switch-160x90-to-6000x5000.mp4";

fn fixture(name: &str) -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../../core/src/tests/fixtures/video").join(name)
}

/// Opens a fixture, or returns `None` when the native library has no video decoding.
fn open(video: &VideoView, name: &str) -> Option<VideoInfo> {
    match video.open(fixture(name)) {
        Ok(info) => Some(info),
        Err(error) if video.last_error().is_some_and(|detail| detail.contains("unavailable")) => {
            eprintln!("SKIP: {error}: this native library was built without FFmpeg");
            None
        }
        Err(error) => panic!("{error}: {:?}", video.last_error()),
    }
}

fn video(app: &TestApp) -> (VideoView, Rc<RefCell<Vec<VideoEvent>>>) {
    let events = Rc::new(RefCell::new(Vec::new()));
    let video = VideoView::new(app).size(20, 6).on_event({
        let events = events.clone();
        move |_cx, event| events.borrow_mut().push(event.clone())
    });
    app.root().add(&video);
    (video, events)
}

/// Lets real time pass and ticks the app's clock, as a running app does, until `done` holds.
fn play_until(app: &TestApp, mut done: impl FnMut() -> bool) {
    for _ in 0..500 {
        if done() {
            return;
        }
        std::thread::sleep(Duration::from_millis(5));
        app.advance(Duration::from_millis(10));
        app.render();
    }
    panic!("playback did not get there in time");
}

fn times(events: &[VideoEvent]) -> usize {
    events.iter().filter(|event| matches!(event, VideoEvent::Time(_))).count()
}

#[test]
fn opening_reports_metadata_and_paints_the_first_frame_while_paused() {
    let app = TestApp::new(20, 6);
    let (video, events) = video(&app);
    let Some(info) = open(&video.audio(false), WITH_AUDIO) else { return };
    // Without audio playback opens no device, and the file still reports its track.
    assert_eq!((info.width, info.height, info.fps, info.has_audio), (160, 90, 24.0, true));
    assert!(info.duration > Duration::from_millis(1900), "{:?}", info.duration);
    assert_eq!(video.info(), Some(info));
    assert!(!open(&video, SILENT).unwrap().has_audio);
    assert!(!video.is_playing());
    // Painting decodes a frame; a paused video gets no ticks.
    play_until(&app, || video.state().unwrap().has_frame);
    app.advance(Duration::from_secs(1));
    assert_eq!(*events.borrow(), []);
    // In a tall node, Contain leaves rows above and below the frame empty, and Fill stretches it over all of them.
    let painted = |fit| {
        video.size(4, 6).fit(fit);
        app.render();
        let capture = app.render();
        capture.cells.iter().filter(|cell| cell.symbol != " " || cell.bg != app.theme().background).count()
    };
    assert_eq!((painted(ImageFit::Fill), painted(ImageFit::Contain) < 24), (24, true));
}

#[test]
fn playing_ticks_at_max_fps_until_paused() {
    let app = TestApp::new(20, 6);
    let (video, events) = video(&app);
    if open(&video, SILENT).is_none() {
        return;
    }
    // Options out of range are ignored or clamped instead of failing.
    video.volume(-1.0).volume(f32::NAN).volume(0.0).muted(true).av_sync_offset(100_000).max_fps(0).max_fps(200);
    video.av_sync_offset(0);
    video.toggle();
    video.play();
    assert_eq!(*events.borrow(), [VideoEvent::Play], "a second play starts nothing");
    assert!(video.is_playing());
    // Setting the same rate again keeps the tick's schedule.
    for _ in 0..25 {
        video.max_fps(10);
        app.advance(Duration::from_millis(40));
    }
    assert_eq!(times(&events.borrow()), 10, "one tick per frame at 10 fps");
    video.max_fps(20);
    app.advance(Duration::from_secs(1));
    assert_eq!(times(&events.borrow()), 30, "a new rate takes effect while playing");
    // Live option changes send only themselves; a volume change keeps the frames coming.
    let mut frames = std::collections::HashSet::new();
    for step in 0..40 {
        video.volume(if step % 2 == 0 { 0.5 } else { 1.0 });
        std::thread::sleep(Duration::from_millis(15));
        app.advance(Duration::from_millis(15));
        frames.insert(format!("{:?}", app.render().cells));
    }
    assert!(frames.len() > 5, "{} distinct frames", frames.len());
    app.try_render().unwrap();
    events.borrow_mut().clear();
    video.pause();
    let position = video.state().unwrap().current_time;
    assert_eq!(*events.borrow(), [VideoEvent::Pause, VideoEvent::Time(position)]);
    assert!(!video.is_playing());
    std::thread::sleep(Duration::from_millis(40));
    app.advance(Duration::from_secs(1));
    assert_eq!(events.borrow().len(), 2, "no ticks while paused");
    assert_eq!(video.state().unwrap().current_time, position);
}

#[test]
fn seeks_clamp_and_playback_reports_its_end_and_failures_drawn_or_not() {
    let app = TestApp::new(20, 6);
    let (video, events) = video(&app);
    let Some(info) = open(&video, SILENT) else { return };
    video.seek(Duration::from_secs(1));
    video.seek(Duration::from_secs(60));
    let expected = [
        VideoEvent::Seek(Duration::from_secs(1)),
        VideoEvent::Time(Duration::from_secs(1)),
        VideoEvent::Seek(info.duration),
        VideoEvent::Time(info.duration),
    ];
    assert_eq!(*events.borrow(), expected, "past the end clamps");
    for (name, visible, from, last) in [
        (SILENT, false, info.duration - Duration::from_millis(30), VideoEvent::Ended),
        (
            SWITCH,
            true,
            Duration::from_millis(950),
            VideoEvent::Error("video frame 6000x5000 exceeds the image limits".into()),
        ),
    ] {
        open(&video.visible(visible), name).unwrap();
        video.seek(from);
        video.play();
        events.borrow_mut().clear();
        play_until(&app, || events.borrow().iter().any(|event| !matches!(event, VideoEvent::Time(_))));
        assert_eq!(events.borrow().last(), Some(&last), "{name}");
        assert!(!video.is_playing(), "{name}");
        let count = events.borrow().len();
        app.advance(Duration::from_secs(1));
        assert_eq!(events.borrow().len(), count, "{name}: no ticks once stopped");
    }
}

#[test]
fn events_that_a_handler_made_stale_are_not_sent() {
    let app = TestApp::new(20, 6);
    let (video, events) = video(&app);
    let Some(info) = open(&video, SILENT) else { return };
    let restarted = Rc::new(std::cell::Cell::new(false));
    video.on_event({
        let (video, restarted) = (video.clone(), restarted.clone());
        move |_cx, event| match event {
            VideoEvent::Time(time) if *time == info.duration && !restarted.replace(true) => {
                video.seek(Duration::ZERO);
                video.play();
            }
            VideoEvent::Pause => video.seek(Duration::ZERO),
            _ => {}
        }
    });
    video.seek(info.duration - Duration::from_millis(30));
    video.play();
    play_until(&app, || restarted.get());
    // A handler restarted the video at its end, so the end is not reported.
    assert!(!events.borrow().contains(&VideoEvent::Ended), "{:?}", events.borrow());
    assert!(video.is_playing());
    // A handler rewound at the pause, so the paused position is not reported after the rewind.
    events.borrow_mut().clear();
    video.pause();
    let rewound = [VideoEvent::Pause, VideoEvent::Seek(Duration::ZERO), VideoEvent::Time(Duration::ZERO)];
    assert_eq!(*events.borrow(), rewound);
}

#[test]
fn looping_wraps_and_autoplay_plays_each_file() {
    let app = TestApp::new(20, 6);
    let (video, events) = video(&app);
    let Some(info) = open(&video.autoplay(true), SILENT) else { return };
    assert_eq!(*events.borrow(), [VideoEvent::Play]);
    video.looping(true);
    video.seek(info.duration - Duration::from_millis(30));
    play_until(&app, || video.state().unwrap().current_time < Duration::from_millis(500));
    assert!(video.is_playing());
    assert!(!events.borrow().contains(&VideoEvent::Ended));
}

#[test]
fn failed_opens_return_the_detail_and_play_waits_for_the_next_file() {
    let app = TestApp::new(20, 6);
    let (video, events) = video(&app);
    if open(&video, SILENT).is_none() {
        return;
    }
    // A path native code cannot take fails before the open file closes, which keeps playing.
    video.play();
    let invalid = |path: &std::path::Path| video.open(path).unwrap_err().status();
    assert_eq!(invalid("".as_ref()), Some(Status::InvalidArgument));
    #[cfg(unix)]
    assert_eq!(
        invalid(<std::ffi::OsStr as std::os::unix::ffi::OsStrExt>::from_bytes(b"\xff.mp4").as_ref()),
        Some(Status::InvalidArgument)
    );
    assert!(video.is_playing());
    app.try_render().unwrap();
    video.pause();
    events.borrow_mut().clear();

    let error = video.open(fixture("missing.mp4")).unwrap_err();
    assert_eq!(error.status(), Some(Status::VideoFailed));
    assert!(video.last_error().is_some());
    assert_eq!((video.info(), video.state()), (None, None));
    // A failed open stops playback; the app keeps running.
    video.play();
    assert!(video.open(fixture("missing.mp4")).is_err());
    assert!(!video.is_playing());
    app.try_render().unwrap();

    // Play before a file opens, and a close, carry playback over to the next file; a pause cancels it.
    video.toggle();
    video.toggle();
    assert!(!video.is_playing());
    video.play();
    assert!(video.is_playing());
    open(&video, SILENT).unwrap();
    assert_eq!(*events.borrow(), [VideoEvent::Play]);
    video.close();
    assert_eq!((video.info(), video.is_playing()), (None, true));
    events.borrow_mut().clear();
    app.advance(Duration::from_secs(1));
    assert_eq!(*events.borrow(), [], "no ticks without a file");
    open(&video, SILENT).unwrap();
    assert_eq!(*events.borrow(), [VideoEvent::Play]);
    // Changing audio reopens the file from its start, playing on.
    video.seek(Duration::from_secs(1));
    video.audio(false);
    assert!(video.is_playing());
    assert!(video.state().unwrap().current_time < Duration::from_secs(1));
}
