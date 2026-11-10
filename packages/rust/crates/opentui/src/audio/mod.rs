//! Sound playback through OpenTUI's native audio engine, as Core's `Audio` plays sounds.
//!
//! An [`Audio`] engine decodes WAV, MP3, or FLAC bytes into [`Sound`]s and mixes up to [`VOICES_MAX`] playing
//! [`Voice`]s at [`SAMPLE_RATE`]. Creating one opens no device: [`Audio::start`] opens the default playback device,
//! whose own thread mixes from then on. [`Audio::start_without_device`] mixes only when [`Audio::mix`] asks, which
//! tests use to hear what would play without making a sound.
//!
//! ```
//! use opentui::audio::Audio;
//! use opentui::native::{Context, ContextOptions};
//!
//! # fn wav() -> Vec<u8> {
//! #     let samples = [0i16, 16384, 0, -16384];
//! #     let data: Vec<u8> = samples.iter().flat_map(|sample| sample.to_le_bytes()).collect();
//! #     let mut bytes = b"RIFF".to_vec();
//! #     bytes.extend((36 + data.len() as u32).to_le_bytes());
//! #     bytes.extend(b"WAVEfmt ");
//! #     bytes.extend(16u32.to_le_bytes());
//! #     bytes.extend(1u16.to_le_bytes()); // PCM
//! #     bytes.extend(1u16.to_le_bytes()); // mono
//! #     bytes.extend(48_000u32.to_le_bytes());
//! #     bytes.extend(96_000u32.to_le_bytes());
//! #     bytes.extend(2u16.to_le_bytes());
//! #     bytes.extend(16u16.to_le_bytes());
//! #     bytes.extend(b"data");
//! #     bytes.extend((data.len() as u32).to_le_bytes());
//! #     bytes.extend(data);
//! #     bytes
//! # }
//! let context = Context::new(ContextOptions::default())?;
//! let audio = Audio::new(&context)?;
//! let sound = audio.load(&wav())?;
//! audio.start_without_device()?;
//! audio.play(sound, 0.5)?;
//! let mut samples = [0.0; 8];
//! audio.mix(&mut samples, 2)?;
//! assert!(samples.iter().any(|sample| *sample != 0.0));
//! # Ok::<(), opentui::Error>(())
//! ```

use crate::error::{Error, Result, Status, check, count};
use crate::native::{Context, Resource};
use crate::sys;
use std::num::NonZeroU32;
use std::rc::Rc;

/// The rate the engine mixes at, in frames per second.
pub const SAMPLE_RATE: u32 = 48_000;

/// The most voices that play at once. [`Audio::play`] returns [`Status::ObjectLimit`] beyond it.
pub const VOICES_MAX: usize = 32;

/// The highest gain [`Audio::play`] and [`Audio::set_volume`] accept; 1 leaves a sound unchanged.
pub const VOLUME_MAX: f32 = 4.0;

/// A decoded sound, valid until its engine is destroyed.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub struct Sound(NonZeroU32);

/// One playing instance of a [`Sound`]. It ends when the sound ends or is stopped; its ID never names a later voice.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub struct Voice(NonZeroU32);

/// A native audio engine owned by a Context. Clones share the engine; the last one destroys it, which stops its
/// device and frees every sound.
#[derive(Clone)]
pub struct Audio(Rc<Resource>);

impl std::fmt::Debug for Audio {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter.debug_struct("Audio").finish_non_exhaustive()
    }
}

impl Audio {
    /// An engine with no sounds and no device.
    pub fn new(context: &Context) -> Result<Self> {
        let resource = Resource::create(
            context,
            "ot_audio_create",
            ("ot_audio_destroy", sys::ot_audio_destroy),
            |context, handle| unsafe { sys::ot_audio_create(context, handle) },
        )?;
        Ok(Self(Rc::new(resource)))
    }

    pub fn context(&self) -> &Context {
        self.0.context()
    }

    /// Opens the default playback device, whose thread then mixes. Starting a started engine does nothing.
    /// Fails with [`Status::AudioDeviceFailed`] where no device opens, and with [`Status::InvalidPhase`] after
    /// [`Self::start_without_device`] until [`Self::stop`].
    pub fn start(&self) -> Result<()> {
        self.start_with(0)
    }

    /// Mixes without a device: [`Self::mix`] reads the mix and nothing plays out loud. Fails with
    /// [`Status::InvalidPhase`] while a device plays.
    pub fn start_without_device(&self) -> Result<()> {
        self.start_with(sys::OT_AUDIO_START_NO_DEVICE)
    }

    fn start_with(&self, flags: u32) -> Result<()> {
        let (context, handle) = self.0.raw();
        check("ot_audio_start", unsafe { sys::ot_audio_start(context, handle, flags) })
    }

    /// Silences the engine and releases its device. Sounds stay loaded; starting again resumes.
    pub fn stop(&self) -> Result<()> {
        let (context, handle) = self.0.raw();
        check("ot_audio_stop", unsafe { sys::ot_audio_stop(context, handle) })
    }

    /// Copies and decodes WAV, MP3, or FLAC bytes. Fails with [`Status::AudioDecodeFailed`] for anything else.
    pub fn load(&self, bytes: &[u8]) -> Result<Sound> {
        let (context, handle) = self.0.raw();
        let mut sound = 0;
        check("ot_audio_load", unsafe {
            sys::ot_audio_load(context, handle, bytes.as_ptr(), bytes.len() as u64, &mut sound)
        })?;
        NonZeroU32::new(sound)
            .map(Sound)
            .ok_or(Error::Native { operation: "ot_audio_load", status: Status::InternalError })
    }

    /// Plays `sound` once at `volume`, a gain from 0 to [`VOLUME_MAX`]. Without a started engine, the voice waits
    /// silently and plays from its start once the engine starts.
    pub fn play(&self, sound: Sound, volume: f32) -> Result<Voice> {
        let (context, handle) = self.0.raw();
        let mut voice = 0;
        check("ot_audio_play", unsafe { sys::ot_audio_play(context, handle, sound.0.get(), volume, &mut voice) })?;
        NonZeroU32::new(voice)
            .map(Voice)
            .ok_or(Error::Native { operation: "ot_audio_play", status: Status::InternalError })
    }

    /// Ends a voice early. A voice that has ended returns [`Status::StaleHandle`].
    pub fn stop_voice(&self, voice: Voice) -> Result<()> {
        let (context, handle) = self.0.raw();
        check("ot_audio_stop_voice", unsafe { sys::ot_audio_stop_voice(context, handle, voice.0.get()) })
    }

    /// The gain of the whole mix, from 0 to [`VOLUME_MAX`]. 1 at first.
    pub fn set_volume(&self, volume: f32) -> Result<()> {
        let (context, handle) = self.0.raw();
        check("ot_audio_set_volume", unsafe { sys::ot_audio_set_volume(context, handle, volume) })
    }

    /// Fills `samples` with the next frames of the mix, `channels` (1 or 2) interleaved samples per frame: the mix
    /// after [`Self::start_without_device`], silence while stopped. A partial last frame stays untouched. Fails with
    /// [`Status::InvalidPhase`] while a device plays.
    pub fn mix(&self, samples: &mut [f32], channels: u32) -> Result<()> {
        let frames = count("ot_audio_mix", samples.len() / channels.max(1) as usize)?;
        let (context, handle) = self.0.raw();
        check("ot_audio_mix", unsafe { sys::ot_audio_mix(context, handle, samples.as_mut_ptr(), frames, channels) })
    }
}

#[cfg(test)]
mod tests;
