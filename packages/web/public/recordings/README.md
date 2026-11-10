# Terminal Illustration Recordings

The files in this directory contain terminal recordings for `<TerminalIllustration>`.

The recording tools are in `scripts/recordings/`. They convert an asciinema `.cast` file to a story `.json` file.

Install `asciinema` on your `PATH` before you use the tools. The package supplies `@xterm/headless` as a development dependency.

## Player Options

Each story can set these options:

- `tone="inherit"` recolors cells from their luminance. It uses the component color or the `ink` overrides.
- `tone="recorded"` uses the recorded foreground colors.
- `background="transparent"` does not paint cell backgrounds.
- `background="recorded"` paints recorded backgrounds and restores the recorded default foreground.
- `padding={false}` removes the terminal-colored margin added around a recorded background.
- `fadeTop`, `fadeRight`, `fadeBottom`, and `fadeLeft` set an edge fade from `0` to `1`.
- `title` and `caption` supply text for the controls.

The default values are `tone="inherit"` and `background="transparent"`.

Use `tone="recorded"` for content in which color conveys information. Use a recorded background when foreground contrast depends on it.

The player calculates fades from cell opacity to keep glyphs sharp. Horizontal fades use the midpoint of each styled run.

Do not use a horizontal fade for prose with long runs. Set `fadeLeft` and `fadeRight` to `0`.

Multiple stories and chapters play in order and repeat. The `controls` option accepts these values:

- `hidden`: Do not show controls. This is the default.
- `hover`: Show overlay controls on hover or focus.
- `visible`: Always show overlay controls.
- `below`: Show controls and captions below the recording.

The player loads a recording when it is within `800px` of the viewport.

See `StoryConfig` and `Props` in `src/components/TerminalIllustration.astro` for all options and defaults.

## Use In Scrollback

Use the Scrollback wrapper in an `.mdx` post:

```mdx
import ScrollbackRecording from "../../components/ScrollbackRecording.astro"

<ScrollbackRecording
  label="OpenTUI terminal recording"
  stories={[
    {
      src: "/recordings/anomaly.json",
      title: "OpenTUI",
      tone: "inherit",
    },
  ]}
/>
```

Use `controls="below"` when chapter captions are part of the article.

## Record A Cast

Run the record tool from `packages/web`:

```bash
scripts/recordings/bin/record out.cast
scripts/recordings/bin/record out.cast -- node demo.mjs
scripts/recordings/bin/record --headless out.cast -- node demo.mjs
scripts/recordings/bin/record --window-size 100x56 out.cast -- bun src/app.ts
```

The tool is also available as `bun run recordings:record`.

If the application uses another working directory, store the absolute tool path first:

```bash
record="$PWD/scripts/recordings/bin/record"
```

### Automatic Applications

Use `--headless` for an application that needs no input. Use `timeout` to set the duration.

```bash
cd ~/src/tuiexperiments/some-headless-app
"$record" --headless --window-size 210x42 /tmp/my-recording.cast \
  -- timeout 16 bun src/app.ts
```

Use a wide, short window for a recording that fills a wide media area.

### Applications With Setup Input

Use `tmux` when an application needs a small amount of setup input:

```bash
tmux new-session -d -s rec -x 200 -y 46
tmux send-keys -t rec -l "cd ~/src/tuiexperiments/some-app && $record /tmp/my-recording.cast -- bun start"
tmux send-keys -t rec Enter
sleep 3
tmux send-keys -t rec -l 's'
sleep 30
tmux send-keys -t rec -l 'q'
tmux kill-session -t rec
```

Make sure that setup keys changed the application before you keep a long recording.

Use `tmux capture-pane -e -p` to examine colors and escape sequences. Plain-text output cannot confirm a color change.

### Interactive Applications

Record continuous interaction directly:

```bash
cd ~/src/tuiexperiments/some-app
"$record" /tmp/my-recording.cast -- bun src/app.ts
```

Use `ctrl+x` to add chapter markers. Use many small inputs when motion must appear continuous.

The build tool keeps only changed frames. A few large inputs produce only a few frames.

## Build A Story

Copy the cast to the tool directory and build it:

```bash
cp /tmp/my-recording.cast scripts/recordings/my-recording.cast
bun run recordings:build scripts/recordings/my-recording.cast
```

The first build creates `scripts/recordings/my-recording.story.config.json`. It also writes `public/recordings/my-recording.json`.

Edit the generated config to set chapter boundaries, captions, and durations. Then build from the config:

```bash
bun run recordings:build scripts/recordings/my-recording.story.config.json
```

Commit the config and the generated story. The repository ignores the cast.

## Check The Story

Check these items before you ship the story:

- Set `atMs` after transient shell output and before the first useful frame.
- Remove persistent title bars, borders, labels, and instructions that do not belong in the composition.
- Set `durationMs` to one cycle for a deterministic animation. The player repeats the story.
- Make sure that setup keys changed the recorded mode. Examine `rows` when you must confirm cell colors.
- Use a recorded tone for prose, tables, and other content that must remain legible.
- Check the final aspect ratio after each crop.

The `fit="cover"` mode sets the font size from the available height. A narrow recording can leave horizontal empty space.

Use this minimum ratio for a full-width composition:

```text
cols / rows >= (boxWidth / boxHeight) * (lineToEm / chToEm)
```

For OpenTUI Mono, `chToEm` is approximately `0.6` and `lineToEm` is approximately `1.1`.

A media-area ratio from `1.2` to `1.3` usually needs a recording ratio from approximately `2.2` to `2.4`.

Record a wider grid or crop rows if the recording does not meet the minimum ratio.

## Ship The Story

Reference the generated file from a page or a Scrollback post:

```astro
<TerminalIllustration
  label="OpenTUI terminal recording"
  stories={[{ src: "/recordings/my-recording.json", tone: "inherit" }]}
  controls="visible"
/>
```

The build writes the file to `public/recordings/`. Do not copy it after the build.
