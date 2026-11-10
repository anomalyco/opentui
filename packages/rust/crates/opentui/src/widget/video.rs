use super::{Behavior, Callbacks, Element, build, handle};
use crate::app::{App, Cx, TimerId};
use crate::error::{Error, Result};
use crate::native::{ImageFit, Node, NodeKind, VideoInfo, VideoState, video_path};
use std::cell::{Cell, RefCell};
use std::fmt::Display;
use std::path::Path;
use std::rc::Rc;
use std::time::Duration;

/// What a [`VideoView`] reports to its [`VideoView::on_event`] handlers.
#[derive(Clone, Debug, PartialEq, Eq)]
#[non_exhaustive]
pub enum VideoEvent {
    /// Playback started.
    Play,
    /// Playback paused; a `Time` event with the position follows.
    Pause,
    /// A seek landed here, clamped to the duration; a `Time` event follows.
    Seek(Duration),
    /// The position: at each tick while playing, and after a pause or a seek.
    Time(Duration),
    /// Playback reached the end of a video that does not loop.
    Ended,
    /// A play, seek, or decode failed, with native code's detail. Playback stops; playing or seeking again retries.
    Error(String),
}

/// The options a player keeps, sent at every open; a change sends only itself.
#[derive(Clone, Copy)]
struct Options {
    autoplay: bool,
    looping: bool,
    audio: bool,
    muted: bool,
    volume: f32,
    av_sync_offset_ms: i32,
    max_fps: u32,
}

pub(crate) struct VideoInner {
    element: Element,
    path: RefCell<Option<String>>,
    info: Cell<Option<VideoInfo>>,
    options: Cell<Options>,
    /// Playback asked for without an open source; the next open starts it.
    requested: Cell<bool>,
    /// Counts opens, plays, pauses, and seeks, so events that follow one a handler made are not sent.
    epoch: Cell<u64>,
    /// Ticks at the video's frame rate while it plays.
    ticker: Cell<Option<TimerId>>,
    events: Callbacks<VideoEvent>,
}

impl Drop for VideoInner {
    fn drop(&mut self) {
        if let (Some(timer), Some(app)) = (self.ticker.get(), self.element.app()) {
            app.cancel_timer(timer);
        }
    }
}

impl VideoInner {
    fn emit(&self, event: &VideoEvent) {
        if let Some(app) = self.element.app() {
            self.events.emit(&mut Cx::new(&app), event);
        }
    }

    /// Emits events in order until a handler opens, plays, pauses, or seeks, which makes the rest stale.
    fn emit_all(&self, events: &[VideoEvent]) {
        let epoch = self.epoch.get();
        for event in events.iter().take_while(|_| self.epoch.get() == epoch) {
            self.emit(event);
        }
    }

    /// Reports a failure as an `Error` event with native code's detail, so a broken file does not end the app.
    fn emit_error(&self, fallback: &dyn Display) {
        let detail = self.element.node.as_ref().and_then(|node| node.video_error().ok()).filter(|d| !d.is_empty());
        self.emit(&VideoEvent::Error(detail.unwrap_or_else(|| fallback.to_string())));
    }

    /// Runs a native control and schedules a redraw. Returns whether it succeeded.
    fn control(&self, call: impl FnOnce(&Node) -> Result<()>) -> bool {
        let Some(node) = &self.element.node else { return false };
        let result = call(node);
        self.element.app().inspect(App::request_redraw);
        result.map_err(|error| self.emit_error(&error)).is_ok()
    }

    fn send_options(&self) {
        let o = self.options.get();
        self.control(|node| {
            node.set_video_loop(o.looping)?;
            node.set_video_muted(o.muted)?;
            node.set_video_volume(o.volume)?;
            node.set_video_av_sync_offset(i64::from(o.av_sync_offset_ms) * 1000)?;
            node.set_video_max_fps(o.max_fps)
        });
    }

    fn state(&self) -> Option<VideoState> {
        self.info.get()?;
        self.element.query(Node::video_state)
    }

    fn playing(&self) -> bool {
        self.state().is_some_and(|state| state.playing)
    }

    fn bump(&self) {
        self.epoch.set(self.epoch.get() + 1);
    }
}

impl Behavior for VideoInner {
    fn element(&self) -> &Element {
        &self.element
    }

    fn teardown(&self) {
        self.events.clear();
    }
}

/// Plays an MP4 (H.264 and AAC) file. Decoding, the media clock, and drawing are native, with the Kitty graphics
/// protocol, Sixel, or half blocks as for [`ImageView`](super::ImageView); audio plays on this machine's default
/// device, also for a [remote](crate::App::remote) app, as in Core.
///
/// While it plays, the widget asks for frames at [`Self::max_fps`] and reports the position with
/// [`VideoEvent::Time`]. Dropping the last handle of a detached video closes its player.
///
/// ```no_run
/// # use opentui::prelude::*;
/// # use opentui::widget::{VideoEvent, VideoView};
/// # let app = App::new(AppOptions::default())?;
/// let video = VideoView::new(&app).size(40, 12).looping(true).autoplay(true);
/// video.on_event(|_cx, event| {
///     if let VideoEvent::Error(detail) = event {
///         eprintln!("video failed: {detail}");
///     }
/// });
/// let info = video.open("clip.mp4")?;
/// app.root().add(&video);
/// # Ok::<(), opentui::Error>(())
/// ```
#[derive(Clone)]
pub struct VideoView(Rc<VideoInner>);

handle!(VideoView, VideoInner);

impl VideoView {
    pub fn new(app: &App) -> Self {
        let options = Options {
            autoplay: false,
            looping: false,
            audio: true,
            muted: false,
            volume: 1.0,
            av_sync_offset_ms: 0,
            max_fps: 30,
        };
        Self(build(app, NodeKind::Video, |element| VideoInner {
            element,
            path: RefCell::new(None),
            info: Cell::new(None),
            options: Cell::new(options),
            requested: Cell::new(false),
            epoch: Cell::new(0),
            ticker: Cell::new(None),
            events: Callbacks::default(),
        }))
    }

    /// Opens a file and shows its first frame, replacing the open one. Playing goes on in the new file, or starts
    /// with [`Self::autoplay`]. A file that does not open returns [`Status::VideoFailed`](crate::Status), with the
    /// detail in [`Self::last_error`], and leaves no file open. An empty path, or one that is not UTF-8, returns
    /// [`Status::InvalidArgument`](crate::Status) and keeps the open file.
    pub fn open(&self, path: impl AsRef<Path>) -> Result<VideoInfo> {
        let path = video_path(path.as_ref())?.to_owned();
        self.load(Some(path)).map(Option::unwrap_or_default)
    }

    /// Closes the open file. A video that was playing plays the next file it opens.
    pub fn close(&self) {
        // Closing only fails for a node native code never created, which the app already reported.
        let _ = self.load(None);
    }

    fn load(&self, path: Option<String>) -> Result<Option<VideoInfo>> {
        let inner = &self.0;
        let resume = self.is_playing();
        let node = inner.element.node.as_ref().ok_or(Error::Usage("the video's native node was not created"))?;
        inner.bump();
        inner.info.set(None);
        let opened = node.video_open(path.as_deref().map(Path::new), inner.options.get().audio);
        let info = opened.as_ref().ok().filter(|_| path.is_some()).copied();
        // A close keeps playing for the next open; a failed open stops, as Core's does.
        inner.requested.set(resume && opened.is_ok() && info.is_none());
        *inner.path.borrow_mut() = path;
        inner.element.app().inspect(App::request_redraw);
        if let Some(info) = info {
            inner.info.set(Some(info));
            inner.send_options();
            if resume || inner.options.get().autoplay {
                self.play();
            }
        }
        self.sync();
        opened.map(|_| info)
    }

    /// The open file's metadata.
    pub fn info(&self) -> Option<VideoInfo> {
        self.0.info.get()
    }

    /// The playback state of the open file. Reading it advances the clock.
    pub fn state(&self) -> Option<VideoState> {
        self.0.state()
    }

    /// Whether the video plays, or will play once a file opens.
    pub fn is_playing(&self) -> bool {
        self.0.requested.get() || self.0.playing()
    }

    /// The detail of the last failure to open, play, seek, or decode, or of audio output, after which playback goes on
    /// silently on the wall clock.
    pub fn last_error(&self) -> Option<String> {
        self.0.element.query(Node::video_error).filter(|detail| !detail.is_empty())
    }

    /// Plays from the current position, or from the start once ended, and emits `Play`. Without an open file, the
    /// next open plays.
    pub fn play(&self) {
        let inner = &self.0;
        if inner.info.get().is_none() {
            inner.requested.set(true);
            return;
        }
        if inner.playing() {
            return;
        }
        inner.bump();
        let started = inner.control(Node::video_play);
        self.sync();
        if started {
            inner.emit(&VideoEvent::Play);
        }
    }

    /// Pauses at the current position and emits `Pause`, then `Time` with the position. Before a file opens, it
    /// cancels a [`Self::play`].
    pub fn pause(&self) {
        let inner = &self.0;
        inner.requested.set(false);
        if !inner.playing() {
            return;
        }
        inner.bump();
        let paused = inner.control(Node::video_pause);
        self.sync();
        if paused && let Some(state) = inner.state() {
            inner.emit_all(&[VideoEvent::Pause, VideoEvent::Time(state.current_time)]);
        }
    }

    pub fn toggle(&self) {
        if self.is_playing() { self.pause() } else { self.play() }
    }

    /// Seeks, clamped to the duration, and emits `Seek`, then `Time`; a seek past the end does not wrap, even when
    /// looping. Seeking a failed video retries it.
    pub fn seek(&self, time: Duration) {
        let inner = &self.0;
        if inner.info.get().is_none() {
            return;
        }
        inner.bump();
        let sought = inner.control(|node| node.video_seek(time));
        self.sync();
        if sought && let Some(state) = inner.state() {
            inner.emit_all(&[VideoEvent::Seek(state.current_time), VideoEvent::Time(state.current_time)]);
        }
    }

    /// Called with each [`VideoEvent`].
    pub fn on_event(&self, handler: impl FnMut(&mut Cx<'_>, &VideoEvent) + 'static) -> Self {
        self.0.events.add(handler);
        self.clone()
    }

    pub fn fit(&self, fit: ImageFit) -> Self {
        self.0.element.apply(|node| node.set_video(fit));
        self.clone()
    }

    /// Stores an option and, while a file is open, sends it alone. Returns whether it changed.
    fn set<T: Copy + PartialEq>(
        &self,
        field: fn(&mut Options) -> &mut T,
        value: T,
        send: impl FnOnce(&Node, T) -> Result<()>,
    ) -> bool {
        let mut options = self.0.options.get();
        if *field(&mut options) == value {
            return false;
        }
        *field(&mut options) = value;
        self.0.options.set(options);
        if self.0.info.get().is_some() {
            self.0.control(|node| send(node, value));
        }
        true
    }

    /// Plays each file once it opens. Off by default.
    pub fn autoplay(&self, autoplay: bool) -> Self {
        self.set(|o| &mut o.autoplay, autoplay, |_, _| Ok(()));
        self.clone()
    }

    /// Starts again at the end. Off by default.
    pub fn looping(&self, looping: bool) -> Self {
        self.set(|o| &mut o.looping, looping, Node::set_video_loop);
        self.clone()
    }

    /// Opens the audio track; on by default. Without it playback opens no audio device and follows the wall clock.
    /// Native code decides at open, so a change reopens the open file from its start, playing on if it played.
    pub fn audio(&self, audio: bool) -> Self {
        if self.set(|o| &mut o.audio, audio, |_, _| Ok(())) && self.0.info.get().is_some() {
            let path = self.0.path.borrow().clone();
            if let Err(error) = self.load(path) {
                self.0.emit_error(&error);
            }
        }
        self.clone()
    }

    /// Silences the audio; the audio device and its clock keep running.
    pub fn muted(&self, muted: bool) -> Self {
        self.set(|o| &mut o.muted, muted, Node::set_video_muted);
        self.clone()
    }

    /// The audio gain, 1 by default. A gain that is negative or not finite is ignored.
    pub fn volume(&self, volume: f32) -> Self {
        if volume.is_finite() && volume >= 0.0 {
            self.set(|o| &mut o.volume, volume, Node::set_video_volume);
        }
        self.clone()
    }

    /// Shows frames this many milliseconds earlier relative to the audio, clamped to ±60,000. A change drops the
    /// frames native code decoded ahead.
    pub fn av_sync_offset(&self, milliseconds: i32) -> Self {
        let milliseconds = milliseconds.clamp(-60_000, 60_000);
        self.set(
            |o| &mut o.av_sync_offset_ms,
            milliseconds,
            |node, ms| node.set_video_av_sync_offset(i64::from(ms) * 1000),
        );
        self.clone()
    }

    /// The highest rate frames present and the widget asks for frames at, clamped to 1 through 120. 30 by default.
    pub fn max_fps(&self, fps: u32) -> Self {
        if self.set(|o| &mut o.max_fps, fps.clamp(1, 120), Node::set_video_max_fps) {
            self.sync();
        }
        self.clone()
    }

    /// Ticks at the frame rate while the video plays, as Core's animation tick: each tick reads the state, which
    /// advances the clock, reports it, and asks for a frame, which draws the next video frame.
    fn sync(&self) {
        let inner = &self.0;
        let Some(app) = inner.element.app() else { return };
        if let Some(timer) = inner.ticker.take() {
            app.cancel_timer(timer);
        }
        if !inner.playing() {
            return;
        }
        let this = Rc::downgrade(&self.0);
        let interval = Duration::from_secs(1) / inner.options.get().max_fps;
        let tick = app.set_interval(interval, move |_cx| {
            if let Some(inner) = this.upgrade() {
                VideoView(inner).poll();
            }
        });
        inner.ticker.set(Some(tick));
    }

    fn poll(&self) {
        let inner = &self.0;
        inner.element.app().inspect(App::request_redraw);
        let state = inner.state();
        // Stop ticking before the events, so a handler that plays again keeps its new tick.
        if !state.is_some_and(|state| state.playing) {
            self.sync();
        }
        let Some(state) = state else { return };
        if state.failed {
            inner.emit_error(&"video playback failed");
        } else if state.ended {
            inner.emit_all(&[VideoEvent::Time(state.current_time), VideoEvent::Ended]);
        } else {
            inner.emit(&VideoEvent::Time(state.current_time));
        }
    }
}
