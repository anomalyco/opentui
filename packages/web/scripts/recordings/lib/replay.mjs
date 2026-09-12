// Replay cast output through xterm.js's headless emulator and snapshot the
// visible screen as compact styled runs at sample times.
import xterm from "@xterm/headless"
import unicode11 from "@xterm/addon-unicode11"

const Terminal = xterm.Terminal ?? xterm.default?.Terminal
const Unicode11Addon = unicode11.Unicode11Addon ?? unicode11.default?.Unicode11Addon

const hex = (value) => "#" + value.toString(16).padStart(6, "0")

function paletteColor(theme, index) {
  if (index < 16) return theme.palette[index]
  if (index < 232) {
    const steps = [0, 95, 135, 175, 215, 255]
    const cube = index - 16
    const r = steps[Math.floor(cube / 36)]
    const g = steps[Math.floor((cube % 36) / 6)]
    const b = steps[cube % 6]
    return hex((r << 16) | (g << 8) | b)
  }
  const gray = 8 + (index - 232) * 10
  return hex((gray << 16) | (gray << 8) | gray)
}

function mixTowardBackground(foreground, background, amount) {
  const parse = (value) => [
    parseInt(value.slice(1, 3), 16),
    parseInt(value.slice(3, 5), 16),
    parseInt(value.slice(5, 7), 16),
  ]
  const [fr, fg, fb] = parse(foreground)
  const [br, bg, bb] = parse(background)
  const channel = (from, to) => Math.round(from + (to - from) * amount)
  return hex((channel(fr, br) << 16) | (channel(fg, bg) << 8) | channel(fb, bb))
}

export async function createReplay(cast, theme) {
  const terminal = new Terminal({
    cols: cast.cols,
    rows: cast.rows,
    scrollback: 0,
    allowProposedApi: true,
  })
  terminal.loadAddon(new Unicode11Addon())
  terminal.unicode.activeVersion = "11"

  const outputs = cast.events.filter((event) => event.type === "o")
  let cursor = 0

  async function feedUntil(atMs) {
    let chunk = ""
    while (cursor < outputs.length && outputs[cursor].at <= atMs) {
      chunk += outputs[cursor].data
      cursor += 1
    }
    if (chunk) await new Promise((resolve) => terminal.write(chunk, resolve))
  }

  function snapshot() {
    const buffer = terminal.buffer.active
    const rows = []
    const texts = []

    for (let y = 0; y < cast.rows; y += 1) {
      const line = buffer.getLine(y + buffer.viewportY)
      const runs = []
      let text = ""

      for (let x = 0; x < cast.cols; x += 1) {
        const cell = line?.getCell(x)
        if (cell && cell.getWidth() === 0) continue // trailing half of a wide char

        let characters = cell?.getChars() || " "
        let foreground = theme.foreground
        let background = theme.background
        if (cell) {
          if (cell.isFgRGB()) foreground = hex(cell.getFgColor())
          else if (cell.isFgPalette()) foreground = paletteColor(theme, cell.getFgColor())
          if (cell.isBgRGB()) background = hex(cell.getBgColor())
          else if (cell.isBgPalette()) background = paletteColor(theme, cell.getBgColor())
          if (cell.isInverse()) [foreground, background] = [background, foreground]
          if (cell.isDim()) foreground = mixTowardBackground(foreground, background, 0.45)
          if (cell.isInvisible()) characters = " "
        }

        const style = {
          f: foreground,
          b: background,
          a: (cell?.isBold() ? "b" : "") + (cell?.isItalic() ? "i" : "") + (cell?.isUnderline() ? "u" : ""),
        }
        text += characters
        const previous = runs[runs.length - 1]
        if (previous && previous.f === style.f && previous.b === style.b && previous.a === style.a) {
          previous.t += characters
        } else {
          runs.push({ t: characters, ...style })
        }
      }

      while (runs.length) {
        const last = runs[runs.length - 1]
        if (/^ *$/.test(last.t) && last.b === theme.background && !last.a.includes("u")) runs.pop()
        else break
      }

      texts.push(text)
      rows.push(
        runs.map((run) => {
          const compact = { t: run.t }
          if (run.f !== theme.foreground) compact.f = run.f
          if (run.b !== theme.background) compact.b = run.b
          if (run.a) compact.a = run.a
          return compact
        }),
      )
    }

    return { rows, text: texts.join("\n") }
  }

  return {
    async sample(atMs) {
      await feedUntil(atMs)
      return snapshot()
    },
    dispose() {
      terminal.dispose()
    },
  }
}
