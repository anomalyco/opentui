// Terminal illustration / story player. Mounts on any element carrying
// `data-terminal-illustration` (one JSON object: `{ stories, defaults }`).
//
// Unlike a full chrome-and-caption story player, this paints cells directly
// on the host background (no window frame, no boxed screen) so it can bleed
// into a page layout. Each story picks its own presentation independently:
//   - tone: "inherit" recolors every cell by luminance into this element's own
//     computed `color` (or an explicit ink override) — the ambient, abstract
//     look. "recorded" paints the recording's own captured foreground colors
//     verbatim, for content meant to read as a real, legible terminal.
//   - background: "transparent" paints no cell backgrounds, so the host
//     background shows through everywhere (required for bleeding onto a
//     page). "recorded" paints the recording's own captured cell backgrounds,
//     i.e. it looks like an actual terminal screen.
// Stories cycle in order and loop forever. An optional controls panel
// (per-story segment dots + a play/pause toggle + a caption) can stay fully
// out of the DOM's visible flow, reveal on hover/focus, or stay always
// visible, via `data-illustration-controls`.
;(function () {
  "use strict"

  var storyRequests = Object.create(null)

  function escapeHtml(value) {
    return value.replace(/[&<>]/g, function (character) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;" }[character]
    })
  }

  // Recordings are a build-time artifact (see public/recordings/README.md),
  // not end-user input, but the pipeline that produces/trims them involves
  // ad hoc scripts — so `run.f`/`run.b` are validated before ever reaching an
  // HTML `style` attribute unescaped, the same as any other untrusted color
  // input would be.
  var HEX_COLOR = /^#[0-9a-f]{6}$/i

  function isHexColor(value) {
    return typeof value === "string" && HEX_COLOR.test(value)
  }

  function luminance(hex) {
    var r = parseInt(hex.slice(1, 3), 16) / 255
    var g = parseInt(hex.slice(3, 5), 16) / 255
    var b = parseInt(hex.slice(5, 7), 16) / 255
    return 0.299 * r + 0.587 * g + 0.114 * b
  }

  function toRgb(hex) {
    return [parseInt(hex.slice(1, 3), 16), parseInt(hex.slice(3, 5), 16), parseInt(hex.slice(5, 7), 16)]
  }

  function mix(a, b, t) {
    return Math.round(a + (b - a) * t)
  }

  // Parses a computed "rgb(r, g, b)" / "rgba(r, g, b, a)" color string.
  function parseComputedColor(value) {
    var match = /rgba?\(\s*([\d.]+)\s*,\s*([\d.]+)\s*,\s*([\d.]+)/.exec(value || "")
    if (!match) return [29, 78, 216]
    return [Math.round(+match[1]), Math.round(+match[2]), Math.round(+match[3])]
  }

  // A 0..1 multiplier for one axis (row or column): ramps in from 0 over the
  // first `startFrac` of `total`, ramps out to 0 over the last `endFrac`, and
  // is 1 in between. Either fraction 0 disables the fade on that edge.
  function edgeFade(pos, total, startFrac, endFrac) {
    if (total <= 1) return 1
    var last = total - 1
    var fadeIn = startFrac > 0 ? pos / (startFrac * last) : 1
    var fadeOut = endFrac > 0 ? (last - pos) / (endFrac * last) : 1
    return Math.max(0, Math.min(1, fadeIn, fadeOut))
  }

  function runHtml(run, opts, edgeAlpha) {
    var style = ""
    var alpha = edgeAlpha
    if (opts.tone === "recorded") {
      if (isHexColor(run.f)) style += "color:" + run.f + ";"
    } else if (isHexColor(run.f)) {
      var eased = Math.pow(luminance(run.f), opts.gamma)
      alpha *= opts.minAlpha + eased * (opts.maxAlpha - opts.minAlpha)
      var r = mix(opts.inkShadow[0], opts.inkHighlight[0], eased)
      var g = mix(opts.inkShadow[1], opts.inkHighlight[1], eased)
      var b = mix(opts.inkShadow[2], opts.inkHighlight[2], eased)
      style += "color:rgb(" + r + "," + g + "," + b + ");"
    }
    if (opts.background === "recorded" && isHexColor(run.b)) style += "background-color:" + run.b + ";"
    // Below this, a difference is imperceptible and not worth the byte cost
    // of an inline style on every unfaded cell (the common case).
    if (alpha < 0.999) style += "opacity:" + alpha.toFixed(3) + ";"
    if (run.a) {
      if (run.a.indexOf("b") !== -1) style += "font-weight:700;"
      if (run.a.indexOf("i") !== -1) style += "font-style:italic;"
      if (run.a.indexOf("u") !== -1) style += "text-decoration:underline;"
    }
    var text = escapeHtml(run.t)
    return style ? '<span style="' + style + '">' + text + "</span>" : text
  }

  function frameHtml(frame, cacheKey, opts, cols, rows) {
    if (!frame.__html) frame.__html = Object.create(null)
    if (frame.__html[cacheKey] === undefined) {
      frame.__html[cacheKey] = frame.rows
        .map(function (row, rowIndex) {
          var rowFade = edgeFade(rowIndex, rows, opts.fadeTop, opts.fadeBottom)
          var col = 0
          return (
            '<span class="terminal-illustration__row">' +
            row
              .map(function (run) {
                // The run's midpoint, not its start column: abstract
                // recordings tend to have many short runs (one per color
                // change), where start vs. midpoint make no visible
                // difference, but real text tends to have a couple of long
                // runs per row (e.g. one run for the whole rest of a
                // sentence). Fading a long run by its start column alone
                // means a line's *entire* opacity is set by wherever it
                // happens to begin — and since indented lines begin at
                // different columns, that reads as near-random flicker from
                // line to line and frame to frame as a document scrolls,
                // not a stable edge fade.
                var colFade = edgeFade(col + run.t.length / 2, cols, opts.fadeLeft, opts.fadeRight)
                col += run.t.length
                return runHtml(run, opts, rowFade * colFade)
              })
              .join("") +
            "</span>"
          )
        })
        .join("")
    }
    return frame.__html[cacheKey]
  }

  // "contain" shrinks a fixed `cols x rows` character grid to fit inside `box`
  // so the whole recording stays visible in both directions. "cover" instead
  // fits the grid's height exactly to the box (so every row is always visible
  // top-to-bottom) and lets width do whatever it does — overflow, cropped by
  // the box's own `overflow: hidden`, or fall short, leaving a margin. Pick a
  // recording whose own column:row ratio is at least as wide as the box for
  // "cover" to actually crop width instead of leaving a gap.
  function measureCellMetrics(screen) {
    var fontFamily = getComputedStyle(screen).fontFamily
    var probe = document.createElement("span")
    probe.style.cssText = "position:absolute;visibility:hidden;font-size:100px;width:1ch;display:block;"
    probe.style.fontFamily = fontFamily
    document.body.appendChild(probe)
    var chToEm = probe.getBoundingClientRect().width / 100
    probe.remove()

    // A terminal row is exactly one cell tall: full-cell glyphs (block
    // elements, braille patterns) on consecutive rows touch, with no leading
    // between them. A typographic line-height like 1.5 inserts leading and
    // slices visible gaps through braille/block art that renders as one
    // connected image in a real terminal. Measure the font's own full-block
    // ink height and use it as the row pitch instead.
    var lineToEm = 0
    try {
      var context = document.createElement("canvas").getContext("2d")
      context.font = "100px " + fontFamily
      if (context.font.indexOf("100px") !== 0) context.font = "100px monospace"
      var block = context.measureText("\u2588")
      lineToEm = (block.actualBoundingBoxAscent + block.actualBoundingBoxDescent) / 100
    } catch (error) {
      lineToEm = 0
    }
    if (!isFinite(lineToEm) || lineToEm <= 0) lineToEm = 1.5

    return { chToEm: chToEm, lineToEm: lineToEm }
  }

  function fitScreenToBox(screen, box, cols, rows, fit, scale, pad) {
    var metrics = measureCellMetrics(screen)
    var chToEm = metrics.chToEm
    if (!chToEm) return function () {}
    var lineToEm = metrics.lineToEm
    screen.style.setProperty("--terminal-illustration-row", lineToEm + "em")

    // A painted recorded background flush against the content reads as
    // cropped; a real terminal window keeps a margin of background around the
    // grid. Pad in cell units (1.5 rows vertically, two columns horizontally
    // — a cell is about twice as tall as it is wide, and rows read tighter
    // than columns at equal cell counts, so the extra half row evens it out
    // visually) and size the grid as if it had those extra cells, so the
    // padding scales with the font and the fit stays exact. Transparent
    // backgrounds bleed into the page on purpose; padding there would only
    // shrink the content.
    var padCols = pad ? 4 : 0
    var padRows = pad ? 3 : 0
    // Story files omit trailing default-background cells. Keep the screen at
    // the recorded grid width so those cells remain visible and alignment does
    // not depend on the longest painted row.
    screen.style.width = cols + "ch"
    screen.style.padding = pad ? 1.5 * lineToEm + "em 2ch" : ""

    if (box.hasAttribute("data-recording-aspect-ratio")) {
      box.style.aspectRatio = String(((cols + padCols) * chToEm) / ((rows + padRows) * lineToEm))
    }

    function apply() {
      var rect = box.getBoundingClientRect()
      if (!rect.width || !rect.height) return
      var fromWidth = rect.width / ((cols + padCols) * chToEm)
      var fromHeight = rect.height / ((rows + padRows) * lineToEm)
      var fontSize = fit === "cover" ? fromHeight : Math.min(fromWidth, fromHeight)
      screen.style.fontSize = Math.max(1, fontSize * scale) + "px"
    }

    apply()
    return apply
  }

  function hasContent(frame) {
    return frame.rows.some(function (row) {
      return row.some(function (run) {
        return run.t.trim().length > 0
      })
    })
  }

  function flattenFrames(story) {
    var frames = []
    var chapters = []
    var offset = 0
    story.chapters.forEach(function (chapter) {
      chapter.frames.forEach(function (frame) {
        frames.push({ at: offset + frame.at, rows: frame.rows })
      })
      var lastAt = chapter.frames.length ? chapter.frames[chapter.frames.length - 1].at : 0
      var span = Math.max(chapter.durationMs || 0, lastAt) + (chapter.holdMs || 0)
      chapters.push({
        at: offset,
        durationMs: span,
        title: chapter.captionTitle || chapter.label || "",
        caption: chapter.caption || "",
      })
      offset += span
    })
    // Real terminal apps render at least one empty frame before their first
    // real paint, and can leave an empty one behind on exit (clearing the
    // alternate screen). Starting a story there — especially right after the
    // crossfade from the previous one — reads as a jarring blank flash rather
    // than a clean cut, and freezing reduced-motion playback there reads as
    // the illustration being broken rather than still. So playback (though
    // not the underlying frame index math) begins at the first frame with
    // visible content, and the reduced-motion "settled" frame is the last one
    // with visible content, not literally frame 0 / the last frame.
    var startIndex = frames.findIndex(hasContent)
    var settledIndex = -1
    for (var i = frames.length - 1; i >= 0; i--) {
      if (hasContent(frames[i])) {
        settledIndex = i
        break
      }
    }
    return {
      cols: story.cols,
      rows: story.rows,
      background: story.background,
      foreground: story.foreground,
      chapters: chapters,
      frames: frames,
      startIndex: startIndex < 0 ? 0 : startIndex,
      settledIndex: settledIndex < 0 ? frames.length - 1 : settledIndex,
      totalDurationMs: offset,
    }
  }

  function numOr(value, fallback) {
    return typeof value === "number" && !Number.isNaN(value) ? value : fallback
  }

  // Merges one story's own config over the illustration's shared defaults, and
  // resolves ink colors (falling back to this element's own computed `color`
  // so mono recordings track light/dark mode automatically).
  function resolveOptions(story, defaults, brandInk) {
    var inkShadowHex = story.inkShadow || story.ink
    var inkHighlightHex = story.inkHighlight || story.ink
    return {
      tone: story.tone || defaults.tone,
      background: story.background || defaults.background,
      gamma: numOr(story.gamma, defaults.gamma),
      minAlpha: numOr(story.minAlpha, defaults.minAlpha),
      maxAlpha: numOr(story.maxAlpha, defaults.maxAlpha),
      inkShadow: inkShadowHex ? toRgb(inkShadowHex) : brandInk,
      inkHighlight: inkHighlightHex ? toRgb(inkHighlightHex) : brandInk,
      fit: story.fit || defaults.fit,
      scale: numOr(story.scale, defaults.scale),
      padding: typeof story.padding === "boolean" ? story.padding : defaults.padding,
      holdMs: numOr(story.holdMs, defaults.holdMs),
      fadeTop: numOr(story.fadeTop, defaults.fadeTop),
      fadeRight: numOr(story.fadeRight, defaults.fadeRight),
      fadeBottom: numOr(story.fadeBottom, defaults.fadeBottom),
      fadeLeft: numOr(story.fadeLeft, defaults.fadeLeft),
      title: story.title,
      caption: story.caption,
    }
  }

  function mount(illustration, config, stories) {
    var screen = illustration.querySelector("[data-illustration-screen]")
    if (!screen || !stories.length) return
    var viewport = illustration.querySelector("[data-illustration-viewport]") || illustration

    var brandInk = parseComputedColor(getComputedStyle(illustration).color)
    var defaults = Object.assign(
      {
        tone: "inherit",
        background: "transparent",
        fit: "contain",
        scale: 1,
        padding: true,
        gamma: 2.2,
        minAlpha: 0.02,
        maxAlpha: 1,
        holdMs: 600,
        fadeTop: 0,
        fadeRight: 0,
        fadeBottom: 0,
        fadeLeft: 0,
      },
      config.defaults,
    )
    var options = config.stories.map(function (story) {
      return resolveOptions(story, defaults, brandInk)
    })
    var cacheKeys = options.map(function (opts) {
      return [
        opts.tone,
        opts.background,
        opts.gamma,
        opts.minAlpha,
        opts.maxAlpha,
        opts.inkShadow.join(","),
        opts.inkHighlight.join(","),
        opts.fadeTop,
        opts.fadeRight,
        opts.fadeBottom,
        opts.fadeLeft,
      ].join(":")
    })
    var reduceMotion = window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches

    var timelines = stories.map(flattenFrames)
    var storyIndex = 0
    var frameIndex = 0
    var elapsed = 0
    var lastTick = 0
    var animationFrame = 0
    var isIntersecting = false
    var playing = false
    var hasStarted = false
    var transitioning = false
    var advanceTimeout = 0
    var resumeAfterIntersection = false
    var resumeAfterVisibility = false
    var refit = function () {}

    var segmentsContainer = illustration.querySelector("[data-illustration-segments]")
    var toggle = illustration.querySelector("[data-illustration-toggle]")
    var captionEl = illustration.querySelector("[data-illustration-caption]")
    var illustrationLabel = illustration.getAttribute("aria-label") || "Terminal illustration"

    function activeTimeline() {
      return timelines[storyIndex]
    }

    function activeOptions() {
      return options[storyIndex]
    }

    // Cancels any in-flight auto-advance crossfade and restores full opacity,
    // so a manual jump or pause can't be silently overridden a moment later
    // by the stale `window.setTimeout` from `advanceStory` (it does not know
    // the story it was fading toward is no longer where playback is).
    function cancelPendingAdvance() {
      window.clearTimeout(advanceTimeout)
      if (transitioning) {
        transitioning = false
        screen.style.opacity = "1"
      }
    }

    // Navigation entries: one per chapter of every story, in playback order.
    // A single-chapter story is one entry titled/captioned from its own MDX
    // config — the build tool generates placeholder chapter captions
    // ("Recording from 0:00 to 0:26.") for casts recorded without narration.
    // A multi-chapter story was authored with per-chapter captions, so those
    // are used as-is.
    var entries = []
    timelines.forEach(function (timeline, index) {
      var single = timeline.chapters.length === 1
      timeline.chapters.forEach(function (chapter) {
        entries.push({
          story: index,
          at: chapter.at,
          durationMs: chapter.durationMs,
          title: single ? options[index].title || "" : chapter.title,
          caption: single ? options[index].caption || "" : chapter.caption,
        })
      })
    })
    illustration.setAttribute("data-segment-count", String(entries.length))

    function activeEntryIndex() {
      var active = 0
      entries.forEach(function (entry, index) {
        if (entry.story === storyIndex && entry.at <= elapsed) active = index
      })
      return active
    }

    function seek(entry) {
      setupStory(entry.story)
      elapsed = entry.at
      var frames = activeTimeline().frames
      while (frameIndex + 1 < frames.length && frames[frameIndex + 1].at <= elapsed) {
        frameIndex += 1
      }
      paint()
      renderCaption()
      renderProgress()
    }

    var buttons = entries.map(function (entry, index) {
      if (!segmentsContainer) return null
      var button = document.createElement("button")
      button.type = "button"
      button.className = "terminal-illustration__segment"
      button.setAttribute("aria-label", "Show " + (entry.title || "chapter " + (index + 1)))
      button.style.setProperty("--progress", "0")
      button.addEventListener("click", function () {
        hasStarted = true
        resumeAfterIntersection = false
        resumeAfterVisibility = false
        cancelPendingAdvance()
        seek(entry)
        play()
      })
      segmentsContainer.appendChild(button)
      return button
    })

    function renderProgress() {
      var active = activeEntryIndex()
      buttons.forEach(function (button, index) {
        if (!button) return
        var progress =
          index === active
            ? Math.min((elapsed - entries[index].at) / (entries[index].durationMs || 1), 1)
            : index < active
              ? 1
              : 0
        button.style.setProperty("--progress", String(progress))
        if (index === active) button.setAttribute("aria-current", "step")
        else button.removeAttribute("aria-current")
      })
    }

    var captionEntry = -1

    function renderCaption() {
      if (!captionEl) return
      var active = activeEntryIndex()
      captionEntry = active
      var entry = entries[active]
      captionEl.textContent = ""
      if (!entry || !entry.caption) return
      if (entry.title) {
        var lead = document.createElement("strong")
        lead.textContent = entry.title + (/[.!?]$/.test(entry.title) ? "" : ".")
        captionEl.appendChild(lead)
        captionEl.appendChild(document.createTextNode(" "))
      }
      captionEl.appendChild(document.createTextNode(entry.caption))
    }

    function setupStory(index, freeze) {
      storyIndex = index
      var timeline = activeTimeline()
      frameIndex = freeze ? timeline.settledIndex : timeline.startIndex
      elapsed = 0
      lastTick = performance.now()
      refit = fitScreenToBox(
        screen,
        viewport,
        timeline.cols,
        timeline.rows,
        activeOptions().fit,
        activeOptions().scale,
        activeOptions().background === "recorded" && activeOptions().padding,
      )
      // background: "recorded" only paints per-cell backgrounds (runHtml),
      // which can leave a hairline seam of whatever's *behind* the screen
      // element between rows — sub-pixel row heights don't always rasterize
      // edge-to-edge, and unlike per-run color/opacity this isn't something
      // per-cell painting can close on its own. Painting the recording's own
      // captured background on the screen element itself as a base layer
      // means any such seam shows that color instead of the host page's.
      screen.style.backgroundColor =
        activeOptions().background === "recorded" && timeline.background ? timeline.background : ""
      // Runs without an explicit `f` are the terminal's *default* foreground;
      // the build strips the color to save bytes. On a transparent background
      // inheriting the page ink is exactly right (mono recordings track
      // light/dark mode), but on the recording's own painted background the
      // page ink has no contrast guarantee — e.g. near-black page ink on a
      // near-black captured background. Restore the captured default
      // foreground for that combination only.
      screen.style.color =
        activeOptions().tone === "recorded" &&
        activeOptions().background === "recorded" &&
        isHexColor(timeline.foreground)
          ? timeline.foreground
          : ""
    }

    function paint() {
      var timeline = activeTimeline()
      screen.innerHTML = frameHtml(
        timeline.frames[frameIndex],
        cacheKeys[storyIndex],
        activeOptions(),
        timeline.cols,
        timeline.rows,
      )
    }

    function updateToggle() {
      if (!toggle) return
      var label = (playing ? "Pause " : hasStarted ? "Resume " : "Play ") + illustrationLabel
      toggle.dataset.state = playing ? "pause" : "play"
      toggle.textContent = playing ? "Pause" : "Play"
      toggle.setAttribute("aria-label", label)
      toggle.setAttribute("aria-pressed", String(playing))
    }

    setupStory(0, reduceMotion)
    paint()
    renderCaption()
    renderProgress()
    updateToggle()

    function advanceStory() {
      setupStory((storyIndex + 1) % stories.length)
      paint()
      renderCaption()
    }

    function tick(now) {
      if (!playing) return
      if (!transitioning) {
        elapsed += Math.min(now - lastTick, 100)

        var timeline = activeTimeline()
        if (elapsed >= timeline.totalDurationMs + activeOptions().holdMs) {
          advanceStory()
        } else {
          var previousFrameIndex = frameIndex
          while (frameIndex + 1 < timeline.frames.length && timeline.frames[frameIndex + 1].at <= elapsed) {
            frameIndex += 1
          }
          if (frameIndex !== previousFrameIndex) paint()
        }
        if (activeEntryIndex() !== captionEntry) renderCaption()
        renderProgress()
      }
      lastTick = now
      animationFrame = window.requestAnimationFrame(tick)
    }

    function play() {
      hasStarted = true
      if (playing) {
        updateToggle()
        return
      }
      playing = true
      lastTick = performance.now()
      updateToggle()
      animationFrame = window.requestAnimationFrame(tick)
    }

    function pause() {
      playing = false
      window.cancelAnimationFrame(animationFrame)
      cancelPendingAdvance()
      updateToggle()
    }

    if (toggle) {
      toggle.addEventListener("click", function () {
        if (playing) {
          resumeAfterIntersection = false
          resumeAfterVisibility = false
          pause()
        } else {
          // Before the very first play, `frameIndex` may still be sitting
          // wherever `setupStory(0, reduceMotion)` left it at mount — the
          // *settled* (last-content) frame when reduced motion froze it
          // there, not the *start* one. `tick`'s frame-advance loop can
          // only ever move `frameIndex` forward, so starting from the last
          // frame means it can't move at all: `elapsed` would tick up with
          // no visible change for this story's entire remaining duration
          // before finally advancing to the next story, reading as the
          // illustration being stuck rather than playing. Resetting to the
          // story's actual start makes "Play" animate immediately. Once
          // `hasStarted`, later pause/resume cycles leave `frameIndex`
          // alone, since by then it's always wherever playback actually
          // left off.
          if (!hasStarted) {
            setupStory(storyIndex)
            paint()
            renderProgress()
          }
          play()
        }
      })
    }

    // Not `refit` directly: `setupStory` reassigns it on every story switch
    // (each recording has its own cols/rows), and `addEventListener` binds
    // the function value it's given at registration time, not a live
    // reference to the variable — so this must re-read `refit` on every
    // resize, or a resize while any story after the first is showing would
    // permanently re-fit using the first story's grid instead.
    window.addEventListener("resize", function () {
      refit()
    })

    document.addEventListener("visibilitychange", function () {
      if (document.hidden) {
        resumeAfterVisibility = playing
        if (playing) pause()
      } else if (resumeAfterVisibility) {
        resumeAfterVisibility = false
        if (isIntersecting) play()
        else resumeAfterIntersection = true
      }
    })

    if ("IntersectionObserver" in window) {
      new IntersectionObserver(
        function (entries) {
          isIntersecting = entries.some(function (entry) {
            return entry.isIntersecting
          })
          if (isIntersecting) {
            if ((!hasStarted && !reduceMotion) || resumeAfterIntersection) {
              resumeAfterIntersection = false
              play()
            }
          } else if (playing) {
            resumeAfterIntersection = true
            pause()
          }
        },
        { threshold: 0.1 },
      ).observe(illustration)
    } else {
      isIntersecting = true
      if (!reduceMotion) play()
    }
  }

  function loadStory(source) {
    if (!storyRequests[source]) {
      storyRequests[source] = fetch(source)
        .then(function (response) {
          if (!response.ok) throw new Error("HTTP " + response.status)
          return response.json()
        })
        .catch(function (error) {
          delete storyRequests[source]
          throw error
        })
    }
    return storyRequests[source]
  }

  function loadAndMount(illustration, config) {
    // `fitScreenToBox` sizes the screen from a measured glyph width. If you
    // measure before OpenTUI Mono loads, the fallback monospace font sets
    // the width. Then the screen is narrower or wider than the box. Wait
    // for fonts before you mount.
    var fontsReady = document.fonts && document.fonts.ready ? document.fonts.ready : Promise.resolve()
    Promise.all(
      config.stories
        .map(function (story) {
          return loadStory(story.src)
        })
        .concat(fontsReady),
    )
      .then(function (loaded) {
        mount(illustration, config, loaded.slice(0, config.stories.length))
      })
      .catch(function () {
        // Leave the static placeholder frame (or nothing) in place; an
        // ambient background illustration failing to load is not worth
        // surfacing an error state for. Its controls, though, are rendered
        // statically regardless of `controls` mode, so without this a
        // "hover"/"visible" instance would show a segment pill and a Play
        // button that do nothing when a recording fails to fetch.
        illustration.setAttribute("data-illustration-controls", "hidden")
      })
  }

  document.querySelectorAll("[data-terminal-illustration]").forEach(function (illustration) {
    var raw = illustration.getAttribute("data-terminal-illustration")
    var config
    try {
      config = JSON.parse(raw)
    } catch (error) {
      return
    }
    if (!config || !Array.isArray(config.stories) || !config.stories.length) return

    // Recordings run from hundreds of KB to several MB each. Defer fetching
    // until the illustration is actually near the viewport, so a page with
    // several instances (or one hidden entirely below a breakpoint, like the
    // hero on narrow viewports) doesn't pay for recordings it never shows. A
    // `display: none` ancestor never intersects, so this also fully skips
    // the fetch there — no separate viewport-width check needed.
    if ("IntersectionObserver" in window) {
      var loader = new IntersectionObserver(
        function (entries) {
          if (
            entries.some(function (entry) {
              return entry.isIntersecting
            })
          ) {
            loader.disconnect()
            loadAndMount(illustration, config)
          }
        },
        { rootMargin: "800px 0px" },
      )
      loader.observe(illustration)
    } else {
      loadAndMount(illustration, config)
    }
  })
})()
