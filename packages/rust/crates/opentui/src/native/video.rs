use super::resource::read_string;
use super::{ImageFit, Node};
use crate::error::{Error, Result, Status, check, count};
use crate::sys;
use std::path::Path;
use std::time::Duration;

/// A video file's metadata, from [`Node::video_open`].
#[derive(Clone, Copy, Debug, Default, PartialEq)]
pub struct VideoInfo {
    pub width: u32,
    pub height: u32,
    /// Frames per second; zero when the file does not say.
    pub fps: f64,
    /// Zero when the file does not say.
    pub duration: Duration,
    /// Whether the file has an audio track, also when it was opened without audio.
    pub has_audio: bool,
}

/// Playback state, from [`Node::video_state`].
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct VideoState {
    pub current_time: Duration,
    pub playing: bool,
    pub ended: bool,
    /// Playing, and the audio clock waits for queued audio.
    pub buffering: bool,
    /// Playing, and audio output drives the clock. Otherwise playback follows the wall clock.
    pub audio: bool,
    /// Whether a frame has been decoded.
    pub has_frame: bool,
    /// A play, seek, or decode failed and playback stopped; [`Node::video_error`] has the detail. Playing or seeking
    /// retries.
    pub failed: bool,
    /// 0 decodes at full size; higher tiers decode Kitty output smaller while output cannot keep up.
    pub quality_tier: u32,
}

/// A path [`Node::video_open`] takes: UTF-8 and not empty, which would close the player instead.
pub(crate) fn video_path(path: &Path) -> Result<&str> {
    let invalid = Error::Native { operation: "ot_video_open", status: Status::InvalidArgument };
    path.to_str().filter(|path| !path.is_empty()).ok_or(invalid)
}

fn micros(time: i64) -> Duration {
    Duration::from_micros(time.max(0) as u64)
}

impl Node {
    /// Sets how a [`NodeKind::Video`](super::NodeKind::Video) node's frames fill it.
    pub fn set_video(&self, fit: ImageFit) -> Result<()> {
        check("ot_scene_set_video", unsafe {
            sys::ot_scene_set_video(self.context_raw(), &self.handle(), fit.raw(), std::ptr::null())
        })
    }

    /// Opens an MP4 (H.264 and AAC) file in a video node, replacing its player, or closes the player with `None`.
    /// Without `audio`, playback opens no audio device and follows the wall clock. A file that does not open returns
    /// [`Status::VideoFailed`], with the detail in [`Self::video_error`], and closes the player. An empty path, or one
    /// that is not UTF-8, returns [`Status::InvalidArgument`] and leaves the player as it was.
    pub fn video_open(&self, path: Option<&Path>, audio: bool) -> Result<VideoInfo> {
        const OPERATION: &str = "ot_video_open";
        let path = match path {
            None => "",
            Some(path) => video_path(path)?,
        };
        let flags = if audio { 0 } else { sys::OT_VIDEO_OPEN_NO_AUDIO };
        let mut raw = sys::ot_video_info::default();
        check(OPERATION, unsafe {
            sys::ot_video_open(
                self.context_raw(),
                &self.handle(),
                path.as_ptr(),
                count(OPERATION, path.len())?,
                flags,
                &mut raw,
            )
        })?;
        Ok(VideoInfo {
            width: raw.width,
            height: raw.height,
            fps: if raw.fps_den == 0 { 0.0 } else { f64::from(raw.fps_num) / f64::from(raw.fps_den) },
            duration: micros(raw.duration_us),
            has_audio: raw.has_audio != 0,
        })
    }

    pub fn video_play(&self) -> Result<()> {
        check("ot_video_play", unsafe { sys::ot_video_play(self.context_raw(), &self.handle()) })
    }

    pub fn video_pause(&self) -> Result<()> {
        check("ot_video_pause", unsafe { sys::ot_video_pause(self.context_raw(), &self.handle()) })
    }

    /// Seeks, clamped to the duration. A seek past the end never wraps, even when looping.
    pub fn video_seek(&self, time: Duration) -> Result<()> {
        let time = i64::try_from(time.as_micros()).unwrap_or(i64::MAX);
        check("ot_video_seek", unsafe { sys::ot_video_seek(self.context_raw(), &self.handle(), time) })
    }

    pub fn set_video_loop(&self, looping: bool) -> Result<()> {
        check("ot_video_set_loop", unsafe {
            sys::ot_video_set_loop(self.context_raw(), &self.handle(), looping.into())
        })
    }

    pub fn set_video_muted(&self, muted: bool) -> Result<()> {
        check("ot_video_set_muted", unsafe {
            sys::ot_video_set_muted(self.context_raw(), &self.handle(), muted.into())
        })
    }

    /// The audio gain: finite and at least 0.
    pub fn set_video_volume(&self, volume: f32) -> Result<()> {
        check("ot_video_set_volume", unsafe { sys::ot_video_set_volume(self.context_raw(), &self.handle(), volume) })
    }

    /// At most 60 s either way; positive shows frames earlier. Native code drops the frames it has decoded ahead.
    pub fn set_video_av_sync_offset(&self, offset_us: i64) -> Result<()> {
        check("ot_video_set_av_sync_offset", unsafe {
            sys::ot_video_set_av_sync_offset(self.context_raw(), &self.handle(), offset_us)
        })
    }

    /// The presentation rate cap, 1 to 120.
    pub fn set_video_max_fps(&self, fps: u32) -> Result<()> {
        check("ot_video_set_max_fps", unsafe { sys::ot_video_set_max_fps(self.context_raw(), &self.handle(), fps) })
    }

    /// Reads the playback state. Reading advances the player's clock, and ends or loops playback at the end.
    pub fn video_state(&self) -> Result<VideoState> {
        let mut raw = sys::ot_video_state::default();
        check("ot_video_get_state", unsafe { sys::ot_video_get_state(self.context_raw(), &self.handle(), &mut raw) })?;
        let flag = |bit| raw.flags & bit != 0;
        Ok(VideoState {
            current_time: micros(raw.current_time_us),
            playing: flag(sys::OT_VIDEO_PLAYING),
            ended: flag(sys::OT_VIDEO_ENDED),
            buffering: flag(sys::OT_VIDEO_BUFFERING),
            audio: flag(sys::OT_VIDEO_AUDIO),
            has_frame: flag(sys::OT_VIDEO_HAS_FRAME),
            failed: flag(sys::OT_VIDEO_ERROR),
            quality_tier: raw.quality_tier,
        })
    }

    /// The detail of the node's last video failure, empty without one.
    pub fn video_error(&self) -> Result<String> {
        let (context, handle) = (self.context_raw(), self.handle());
        read_string("ot_video_get_error", |bytes, capacity, length| unsafe {
            sys::ot_video_get_error(context, &handle, bytes, capacity, length)
        })
    }
}
