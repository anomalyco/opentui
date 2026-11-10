# Audio stream fixtures

The fixtures are deterministic 48 kHz mono MP3 and FLAC files containing 750 Hz
and 3000 Hz sine waves. The CBR MP3s have no ID3 or Xing headers and most use
32 kb/s. The five-second MP3 provides one continuous encoded stream; the
one-second 320 kb/s MP3 initializes the decoder below longer startup thresholds.

Generated with ffmpeg 8.0:

Substitute the frequency, duration, bitrate, and output filename for each listed variant.

```sh
ffmpeg -hide_banner -loglevel error \
  -f lavfi -i "sine=frequency=FREQUENCY:sample_rate=48000:duration=DURATION" \
  -map_metadata -1 -ac 1 -ar 48000 \
  -c:a libmp3lame -b:a 32k \
  -write_xing 0 -id3v2_version 0 -write_id3v1 0 \
  tone-750hz-48k-mono-1s.mp3
```

The FLAC fixture uses the same input and channel options with `-c:a flac`.

SHA-256:

- `tone-750hz-48k-mono-1s.mp3`: `82b137c8b36a174ea5c471c27dc55aaf0e3c978cb95b521dc37031e62441a94a`
- `tone-750hz-48k-mono-1s-320k.mp3`: `3f853410beb7a5065d9ba22ad7aa261c25c3b6fb063107fffb5cee192b8abcc0`
- `tone-750hz-48k-mono-5s.mp3`: `722fdb73a27c97008959cfd91b7e79e1265bd92cc697cf6cfc286cbb95f07586`
- `tone-3000hz-48k-mono-1s.mp3`: `065d354a0b46bc1d5e0cedcb27fffb5f49a50b57339837b3b7cd9437fc1d3b57`
- `tone-750hz-48k-mono-1s.flac`: `81cefdd891acdafc670528dcd7689efe8c5b166cfbe8ab2db29222935e0f0887`
