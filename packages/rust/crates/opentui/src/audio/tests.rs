use super::*;
use crate::native::ContextOptions;

/// A mono 16-bit PCM WAV at the engine's rate, every sample `level`.
fn wav(level: i16, frames: usize) -> Vec<u8> {
    let data: Vec<u8> = std::iter::repeat_n(level.to_le_bytes(), frames).flatten().collect();
    let mut bytes = b"RIFF".to_vec();
    bytes.extend((36 + data.len() as u32).to_le_bytes());
    bytes.extend(b"WAVEfmt ");
    bytes.extend(16u32.to_le_bytes());
    bytes.extend(1u16.to_le_bytes());
    bytes.extend(1u16.to_le_bytes());
    bytes.extend(SAMPLE_RATE.to_le_bytes());
    bytes.extend((SAMPLE_RATE * 2).to_le_bytes());
    bytes.extend(2u16.to_le_bytes());
    bytes.extend(16u16.to_le_bytes());
    bytes.extend(b"data");
    bytes.extend((data.len() as u32).to_le_bytes());
    bytes.extend(data);
    bytes
}

fn engine() -> Result<Audio> {
    Audio::new(&Context::new(ContextOptions::default())?)
}

fn status<T: std::fmt::Debug>(result: Result<T>) -> Status {
    result.unwrap_err().status().unwrap()
}

/// The loudest sample of the next `frames` stereo frames.
fn peak(audio: &Audio, frames: usize) -> Result<f32> {
    let mut samples = vec![0.0; frames * 2];
    audio.mix(&mut samples, 2)?;
    Ok(samples.iter().fold(0.0, |peak: f32, sample| peak.max(sample.abs())))
}

#[test]
fn played_sounds_reach_the_mix_scaled_by_voice_and_master_volume() -> Result<()> {
    let audio = engine()?;
    let sound = audio.load(&wav(16384, 4800))?;
    audio.start_without_device()?;
    // The level once the voice has settled: the last left sample of a block.
    let measure = |volume| -> Result<f32> {
        let voice = audio.play(sound, volume)?;
        let mut samples = vec![0.0; 512];
        audio.mix(&mut samples, 2)?;
        audio.stop_voice(voice)?;
        Ok(samples[510])
    };
    let full = measure(1.0)?;
    assert!(full > 0.1, "{full}");
    let half = measure(0.5)?;
    assert!((half - full / 2.0).abs() < 1e-3, "{half} vs {full}");
    audio.set_volume(0.0)?;
    assert_eq!(measure(1.0)?, 0.0);
    Ok(())
}

#[test]
fn voices_end_with_their_sound_or_when_stopped() -> Result<()> {
    let audio = engine()?;
    let sound = audio.load(&wav(16384, 64))?;
    audio.start_without_device()?;
    let voice = audio.play(sound, 1.0)?;
    audio.stop_voice(voice)?;
    assert_eq!(peak(&audio, 128)?, 0.0, "a stopped voice is silent");
    assert_eq!(status(audio.stop_voice(voice)), Status::StaleHandle);
    let voice = audio.play(sound, 1.0)?;
    assert!(peak(&audio, 1024)? > 0.1);
    assert_eq!(peak(&audio, 128)?, 0.0);
    assert_eq!(status(audio.stop_voice(voice)), Status::StaleHandle, "the voice ran out");
    let later = audio.play(sound, 1.0)?;
    assert_ne!(later, voice, "an ended voice's ID never names a later one");
    Ok(())
}

#[test]
fn a_stopped_engine_mixes_silence() -> Result<()> {
    let audio = engine()?;
    let sound = audio.load(&wav(16384, 4800))?;
    audio.play(sound, 1.0)?;
    assert_eq!(peak(&audio, 256)?, 0.0, "never started");
    audio.start_without_device()?;
    assert!(peak(&audio, 256)? > 0.1, "the waiting voice plays once the engine starts");
    audio.stop()?;
    audio.play(sound, 1.0)?;
    assert_eq!(peak(&audio, 256)?, 0.0, "stopped");
    Ok(())
}

#[test]
fn bad_input_is_rejected() -> Result<()> {
    let audio = engine()?;
    assert_eq!(status(audio.load(b"not a sound")), Status::AudioDecodeFailed);
    let sound = audio.load(&wav(1, 4))?;
    for volume in [-0.1, VOLUME_MAX + 0.1, f32::NAN] {
        assert_eq!(status(audio.play(sound, volume)), Status::InvalidArgument, "{volume}");
        assert_eq!(status(audio.set_volume(volume)), Status::InvalidArgument, "{volume}");
    }
    assert_eq!(status(audio.mix(&mut [0.0; 3], 3)), Status::InvalidArgument);
    Ok(())
}

#[test]
fn at_most_32_voices_play_at_once() -> Result<()> {
    let audio = engine()?;
    let sound = audio.load(&wav(1, 4800))?;
    for _ in 0..VOICES_MAX {
        audio.play(sound, 0.1)?;
    }
    assert_eq!(status(audio.play(sound, 0.1)), Status::ObjectLimit);
    Ok(())
}
