type Rect = readonly [x: number, y: number, width: number, height: number]
type Circle = readonly [x: number, y: number, radius: number]
type InkLayer = { ink: string } & ({ rectangles: Rect[] } | { circles: Circle[] })

export interface WordmarkStudy {
  id: string
  name: string
  group: string
  note: string
  layers: InkLayer[]
}

const cyan = "#0084d6"
const magenta = "#ff1c94"
const yellow = "#fff400"
const indigo = "#171080"

export const baseRows = [
  "................#........",
  "###.###.###.##..###.#.#.#",
  "#.#.#.#.#.#.#.#.#...#.#.#",
  "#.#.#.#.#...#.#.#.#.#.#.#",
  "###.###.###.#.#.###.###.#",
  "....#....................",
]

function bitmap(rows: string[]): Rect[] {
  return rows.flatMap((row, y) => [...row].flatMap((cell, x): Rect[] => (cell === "#" ? [[x, y, 1, 1]] : [])))
}

const cells = bitmap(baseRows)
const has = (x: number, y: number) => baseRows[y]?.[x] === "#"

function runs(vertical: boolean): Rect[] {
  const dx = vertical ? 0 : 1
  const dy = vertical ? 1 : 0
  return cells.flatMap(([x, y]): Rect[] => {
    if (has(x - dx, y - dy)) return []
    let length = 1
    while (has(x + length * dx, y + length * dy)) length++
    if (length < 2) return []
    return [[x, y, vertical ? 1 : length, vertical ? length : 1]]
  })
}

const horizontal = runs(false)
const vertical = runs(true)
const layer = (ink: string, rectangles: Rect[]): InkLayer => ({ ink, rectangles })
const covers = ([x, y, width, height]: Rect, [cx, cy]: Rect) => cx >= x && cx < x + width && cy >= y && cy < y + height

const connected: Rect[] = [
  [4, 4, 1, 2],
  [12, 1, 1, 4],
  [12, 1, 2, 1],
  [14, 2, 1, 3],
  [16, 0, 1, 5],
  [16, 4, 3, 1],
  [18, 3, 1, 2],
  [24, 1, 1, 4],
]
const crossbar: Rect[] = [[16, 1, 3, 1]]

function complementary(plate: Rect[], joins: string[]) {
  return cells.filter((cell) => !plate.some((rect) => covers(rect, cell)) || joins.includes(`${cell[0]},${cell[1]}`))
}

const body = complementary(connected, ["4,4", "16,1"])
const bowls: Rect[] = [
  [4, 4, 1, 2],
  [12, 1, 1, 4],
  [16, 0, 1, 5],
  [24, 1, 1, 4],
]

function shapes(id: string, name: string, group: string, note: string, layers: InkLayer[]): WordmarkStudy {
  return { id, name, group, note, layers }
}

function inks(id: string, name: string, first: string, second: string): WordmarkStudy {
  return shapes(id, name, "Ink combinations", "The connected construction, with a different pair of inks.", [
    layer(first, body),
    layer(second, connected),
  ])
}

export const wordmarkStudies: WordmarkStudy[] = [
  shapes("00", "Starting point", "Reference", "The three-ink mark on the site when this comparison was made.", [
    layer(
      cyan,
      body.filter((cell) => !crossbar.some((rect) => covers(rect, cell))),
    ),
    layer(magenta, connected),
    layer(yellow, crossbar),
  ]),
  shapes("01", "One ink", "Structure", "The existing letterforms, without color divisions.", [layer(indigo, cells)]),
  shapes("02", "Alternating letters", "Structure", "A regular blue / pink cadence, like the postage-stamp book.", [
    layer(
      cyan,
      cells.filter(([x]) => Math.floor(x / 4) % 2 === 0),
    ),
    layer(
      magenta,
      cells.filter(([x]) => Math.floor(x / 4) % 2 === 1),
    ),
  ]),
  shapes("03", "Open / TUI", "Structure", "Color separates the two parts of the name instead of individual strokes.", [
    layer(
      cyan,
      cells.filter(([x]) => x < 16),
    ),
    layer(
      magenta,
      cells.filter(([x]) => x >= 16),
    ),
  ]),
  shapes("04", "All crossings", "Structure", "Blue crossbars and pink stems. Every intersection prints dark.", [
    layer(cyan, horizontal),
    layer(magenta, vertical),
  ]),
  shapes("05", "Main stems", "Structure", "Only the main stems print pink; the returning strokes stay blue.", [
    layer(cyan, [...horizontal, ...vertical.filter(([x]) => x % 4 !== 0)]),
    layer(
      magenta,
      vertical.filter(([x]) => x % 4 === 0),
    ),
  ]),
  shapes("06", "Intact bowls", "Structure", "Blue letter bodies with separate pink stems and descender.", [
    layer(cyan, complementary(bowls, ["4,4", "12,1", "16,1", "16,4"])),
    layer(magenta, bowls),
  ]),
  shapes("07", "Connected forms", "Structure", "The n shoulder and t foot print as connected pink parts. No yellow.", [
    layer(cyan, body),
    layer(magenta, connected),
  ]),
  shapes("08", "Extending stems", "Structure", "Pink appears only on the p and t, which extend beyond the x-height.", [
    layer(cyan, [...horizontal, ...vertical.filter(([x]) => x !== 4 && x !== 16)]),
    layer(
      magenta,
      vertical.filter(([x]) => x === 4 || x === 16),
    ),
  ]),
  inks("09", "Cobalt / vermilion", "#2046e8", "#ff381d"),
  inks("10", "Ultramarine / pink", "#2010bf", "#ff178b"),
  inks("11", "Pink / cyan", magenta, cyan),
  inks("12", "Black / vermilion", "#171717", "#f43820"),
  inks("13", "Cyan / indigo", cyan, indigo),
  shapes(
    "14",
    "Yellow underprint",
    "Ink combinations",
    "Yellow under both passes mixes green, orange and dark joins.",
    [layer(yellow, cells), layer(cyan, horizontal), layer(magenta, vertical)],
  ),
  shapes("15", "Split inks", "Overprints", "Two inks overlap inside each existing cell; the outline stays solid.", [
    layer(
      cyan,
      cells.map(([x, y]): Rect => [x, y, 0.65, 1]),
    ),
    layer(
      magenta,
      cells.map(([x, y]): Rect => [x + 0.35, y, 0.65, 1]),
    ),
  ]),
  shapes("16", "Dot overprint", "Overprints", "Magenta dots print over a solid cyan wordmark. No cells are removed.", [
    layer(cyan, cells),
    { ink: magenta, circles: cells.map(([x, y]): Circle => [x + 0.5, y + 0.5, 0.36]) },
  ]),
  shapes(
    "17",
    "Alternating density",
    "Overprints",
    "A second pass darkens alternate cells, without changing their shape.",
    [
      layer(cyan, cells),
      layer(
        magenta,
        cells.filter(([x, y]) => (x + y) % 2 === 0),
      ),
    ],
  ),
  shapes("18", "Cross overprint", "Overprints", "Cross-shaped ink marks sit inside the solid original letters.", [
    layer(cyan, cells),
    layer(
      magenta,
      cells.flatMap(([x, y]): Rect[] => [
        [x, y + 0.33, 1, 0.34],
        [x + 0.33, y, 0.34, 1],
      ]),
    ),
  ]),
  shapes(
    "19",
    "Reversed crossings",
    "Ink placement",
    "Pink crossbars and cyan stems, reversing the first stroke study.",
    [layer(magenta, horizontal), layer(cyan, vertical)],
  ),
  shapes("20", "Lower strokes", "Ink placement", "Pink occupies the lower strokes, with one shared row of overprint.", [
    layer(
      cyan,
      cells.filter(([, y]) => y <= 3),
    ),
    layer(
      magenta,
      cells.filter(([, y]) => y >= 3),
    ),
  ]),
  shapes("21", "Upper strokes", "Ink placement", "Pink occupies the upper strokes; the lower parts stay cyan.", [
    layer(
      cyan,
      cells.filter(([, y]) => y >= 2),
    ),
    layer(
      magenta,
      cells.filter(([, y]) => y <= 2),
    ),
  ]),
  shapes("22", "Return strokes", "Ink placement", "Pink moves to the returning stems, rather than the main stems.", [
    layer(cyan, [...horizontal, ...vertical.filter(([x]) => x % 4 === 0)]),
    layer(
      magenta,
      vertical.filter(([x]) => x % 4 !== 0),
    ),
  ]),
  shapes(
    "23",
    "Three-ink stems",
    "Ink placement",
    "Yellow over the main stems adds red-orange and deeper intersections.",
    [
      layer(cyan, horizontal),
      layer(magenta, vertical),
      layer(
        yellow,
        vertical.filter(([x]) => x % 4 === 0),
      ),
    ],
  ),
  shapes("24", "Overprinted letters", "Ink placement", "Whole letters cycle through cyan, magenta and their overlap.", [
    layer(
      cyan,
      cells.filter(([x]) => Math.floor(x / 4) % 3 !== 1),
    ),
    layer(
      magenta,
      cells.filter(([x]) => Math.floor(x / 4) % 3 !== 0),
    ),
  ]),
]

export const studyGroups = ["Structure", "Ink combinations", "Overprints", "Ink placement"]
