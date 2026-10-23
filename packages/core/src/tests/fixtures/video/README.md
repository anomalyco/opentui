# Video fixtures

`testsrc-160x90-24fps-2s.mp4` is a deterministic two-second 160x90 24 fps H.264 video with a 48 kHz stereo AAC
440 Hz sine track. It contains only generated content.

Generated with ffmpeg 6.1:

```sh
ffmpeg -f lavfi -i "testsrc2=size=160x90:rate=24:duration=2" \
  -f lavfi -i "sine=frequency=440:sample_rate=48000:duration=2" -ac 2 \
  -c:v libx264 -preset veryslow -crf 30 -pix_fmt yuv420p -g 24 -bf 0 \
  -c:a aac -b:a 64k -map_metadata -1 -fflags +bitexact -flags:v +bitexact -flags:a +bitexact \
  -movflags +faststart testsrc-160x90-24fps-2s.mp4
```

`testsrc-160x90-24fps-2s-video-only.mp4` is the same video stream without audio, so tests can play it without an
audio device:

```sh
ffmpeg -i testsrc-160x90-24fps-2s.mp4 -map 0:v -c copy -map_metadata -1 -fflags +bitexact \
  -movflags +faststart testsrc-160x90-24fps-2s-video-only.mp4
```

`gop-160x90-24fps-12s.mp4` is a 12-second 160x90 24 fps H.264 video without audio and with keyframes at 0 s and
6 s only, for long-gap decoding tests. `single-frame-10us.mp4` is one 64x64 frame lasting 10 microseconds, for
looping a clip shorter than a paint. `oversized-6000x5000.mp4` is one black 6000x5000 frame, above the 25 MP image
limit. They contain only generated content.

Generated with ffmpeg 6.1:

```sh
ffmpeg -f lavfi -i "testsrc2=size=160x90:rate=24:duration=12" -c:v libx264 -preset veryslow -crf 40 \
  -pix_fmt yuv420p -g 144 -keyint_min 144 -sc_threshold 0 -bf 0 \
  -map_metadata -1 -fflags +bitexact -flags:v +bitexact -movflags +faststart gop-160x90-24fps-12s.mp4
ffmpeg -f lavfi -i "color=gray:size=64x64:rate=100000:duration=0.00001" -frames:v 1 -c:v libx264 -preset veryslow \
  -pix_fmt yuv420p -bf 0 -video_track_timescale 1000000 \
  -map_metadata -1 -fflags +bitexact -flags:v +bitexact -movflags +faststart single-frame-10us.mp4
ffmpeg -f lavfi -i "color=black:size=6000x5000:rate=1:duration=1" -frames:v 1 -c:v libx264 -preset veryslow -crf 51 \
  -pix_fmt yuv420p -map_metadata -1 -fflags +bitexact -flags:v +bitexact -movflags +faststart oversized-6000x5000.mp4
```
