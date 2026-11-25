import { describe, expect, test } from "bun:test"
import conformance from "./slots.conformance.json" with { type: "json" }
import {
  resolveSlotClaims,
  slotPathContains,
  SlotTree,
  type SlotClaimPlacement,
  type SlotPlacementKind,
  type SlotPlacementOf,
} from "./tree.js"

type Row = [string, keyof typeof conformance.paths, [SlotPlacementKind, string][], Expected]
type Expected = {
  placed: Record<string, Partial<Record<Exclude<SlotPlacementKind, "replace">, number[]> & { replace: number }>>
  suppressed: [number, number | null][]
  degraded: [number, string][]
}

describe("resolveSlotClaims conformance", () => {
  test.each(conformance.contains as [string, string, boolean][])(
    "slotPathContains(%p, %p) is %p",
    (ancestor, path, want) => {
      expect(slotPathContains(ancestor, path)).toBe(want)
    },
  )

  test.each(conformance.rows as unknown as Row[])("%s", (_name, paths, rows, expected) => {
    const claims: SlotClaimPlacement[] = rows.map(([kind, target]) => ({ kind, target }))
    const index = (claim: SlotClaimPlacement) => claims.indexOf(claim)
    const result = resolveSlotClaims({ paths: new Set(conformance.paths[paths]), claims })
    const placed: Expected["placed"] = {}
    for (const [path, slotted] of result.placed) {
      const entry: Expected["placed"][string] = {}
      for (const kind of ["before", "prepend", "append", "after"] as const) {
        if (slotted[kind].length > 0) entry[kind] = slotted[kind].map(index)
      }
      if (slotted.replace) entry.replace = index(slotted.replace)
      placed[path] = entry
    }
    expect({
      placed,
      suppressed: result.suppressed.map(({ claim, by }) => [index(claim), by ? index(by) : null]),
      degraded: result.degraded.map(({ claim, to }) => [index(claim), to]),
    }).toEqual(expected)
  })
})

type Slots = { a: {}; "a.b": {}; c: {} }
type AppClaim = { [P in keyof Slots]: SlotPlacementOf<P> & { render(input: Slots[P]): string } }[keyof Slots]

describe("SlotTree", () => {
  const render = (label: string) => () => label
  const labels = (tree: SlotTree<string, Slots>, path: keyof Slots) => {
    const placed = tree.placed(path)
    return [...placed.before, ...placed.prepend, ...placed.append, ...placed.after].map((entry) =>
      entry.claim.render({}),
    )
  }

  test("orders by the owner's place, then the claim's number; reset and order(ids) keep places", () => {
    const tree = new SlotTree<string, Slots>()
    tree.mount("a")
    const x = tree.owner("x")
    const y = tree.owner("y")
    y.claim({ append: "a", render: render("y0") })
    x.claim({ append: "a", render: render("x0") })
    // An app's own claim type has no order; one that an untyped plugin adds anyway is ignored.
    const untyped = { append: "a", order: -2, render: render("x1") } as AppClaim
    x.claim({ ...untyped, render: () => untyped.render({}) })
    expect(labels(tree, "a")).toEqual(["x0", "x1", "y0"])

    x.reset()
    x.claim({ append: "a", render: render("x2") })
    expect(labels(tree, "a")).toEqual(["x2", "y0"])

    tree.owner("z").claim({ append: "a", render: render("z0") })
    tree.order(["z", "x"])
    expect(labels(tree, "a")).toEqual(["z0", "y0", "x2"])
  })

  test("order(ids) also places owners created later, created again, or after clear()", () => {
    const tree = new SlotTree<string, Slots>()
    tree.mount("a")
    const open = (id: string) => tree.owner(id).claim({ append: "a", render: render(id) })
    tree.order(["x", "y", "z"])
    for (const id of ["z", "y", "x"]) open(id)
    expect(labels(tree, "a")).toEqual(["x", "y", "z"])
    tree.owner("x").remove()
    open("x")
    expect(labels(tree, "a")).toEqual(["x", "y", "z"])
    const z = tree.owner("z")
    tree.clear()
    z.claim({ append: "a", render: render("late") })
    expect(labels(tree, "a")).toEqual([])
    for (const id of ["z", "y", "x"]) open(id)
    expect(labels(tree, "a")).toEqual(["x", "y", "z"])
  })

  test("a stage shows its claims once it commits, replacing the owner's, and adds nothing once it ended", () => {
    const tree = new SlotTree<string, Slots>()
    tree.mount("a")
    let notified = 0
    tree.subscribe(() => notified++)
    const x = tree.owner("x")
    const kept = { append: "a" as const, render: render("kept") }
    const first = x.stage()
    const releaseKept = first.claim(kept)
    first.claim({ append: "a", render: render("x0") })()
    expect([labels(tree, "a"), notified]).toEqual([[], 0])
    first.commit()
    first.claim({ append: "a", render: render("x1") })
    expect([labels(tree, "a"), notified]).toEqual([["kept", "x1"], 2])
    const entry = tree.placed("a").append[0]

    // A setup that fails disposes its stage unseen; one that succeeds replaces the owner's claims in one change, and
    // a claim object it shows already keeps its tree object.
    const failed = x.stage()
    failed.claim({ append: "a", render: render("failed") })
    failed.dispose()
    failed.commit()
    const second = x.stage()
    const x2 = { append: "a" as const, render: render("x2") }
    second.claim(x2)
    second.claim(kept)
    second.commit()
    releaseKept()
    expect([labels(tree, "a"), notified]).toEqual([["x2", "kept"], 3])
    expect(tree.placed("a").append[1]).toBe(entry!)
    // A commit of the claims the owner shows changes nothing; a kept claim's release removes the claim shown.
    const same = x.stage()
    same.claim(x2)
    const releaseSame = same.claim(kept)
    same.commit()
    expect(notified).toBe(3)
    releaseSame()
    expect([labels(tree, "a"), notified]).toEqual([["x2"], 4])

    // An ended stage, such as a deactivated plugin's, adds nothing; a stage after reset() works.
    first.claim({ append: "a", render: render("late") })
    x.reset()
    second.claim({ append: "a", render: render("late") })
    const third = x.stage()
    third.claim({ append: "a", render: render("x3") })
    third.commit()
    expect([labels(tree, "a"), notified]).toEqual([["x3"], 6])
    // Disposing a committed stage drops the owner's claims and leaves the stages after it open.
    const fourth = x.stage()
    fourth.claim({ append: "a", render: render("x4") })
    third.dispose()
    expect([labels(tree, "a"), notified]).toEqual([[], 7])
    fourth.commit()
    expect([labels(tree, "a"), notified]).toEqual([["x4"], 8])
  })

  test("opening an owner moves no other owner and notifies no one; a removed owner's handle does nothing", () => {
    const tree = new SlotTree<string, Slots>()
    tree.mount("a")
    tree.order(["x", "y"])
    const open = (id: string) => tree.owner(id).claim({ append: "a", render: render(id) })
    open("y")
    open("u")
    let notified = 0
    tree.subscribe(() => notified++)
    tree.owner("x")
    expect([labels(tree, "a"), notified]).toEqual([["y", "u"], 0])
    open("x")
    expect([labels(tree, "a"), notified]).toEqual([["x", "y", "u"], 1])

    const y = tree.owner("y")
    y.remove()
    y.claim({ append: "a", render: render("late") })()
    const stage = y.stage()
    stage.claim({ append: "a", render: render("late") })
    stage.commit()
    y.reset()
    y.remove()
    tree.owner("empty").remove()
    expect([labels(tree, "a"), notified]).toEqual([["x", "u"], 2])
  })

  test("a claim keeps its object while other owners change", () => {
    const tree = new SlotTree<string, Slots>()
    tree.mount("a")
    tree.owner("x").claim({ append: "a", render: render("x") })
    const before = tree.placed("a").append[0]
    const y = tree.owner("y")
    y.claim({ append: "a", render: render("y") })
    y.reset()
    expect(tree.placed("a").append).toEqual([before!])
    expect(tree.placed("a").append[0]).toBe(before!)
  })

  test("mounts are counted: listeners run only when the set of paths changes", () => {
    const tree = new SlotTree<string, Slots>()
    let notified = 0
    tree.subscribe(() => notified++)
    const first = tree.mount("a")
    const second = tree.mount("a")
    first()
    first()
    expect(notified).toBe(1)
    second()
    expect(notified).toBe(2)
    expect(() => tree.mount("c", { within: "a" })).toThrow('Slot "c" is mounted inside "a"')
    tree.mount("a.b", { within: "a" })
    tree.batch(() => {
      tree.mount("a")
      tree.batch(() => tree.owner("x").claim({ before: "a.b", render: render("x") }))
      expect(notified).toBe(3)
    })
    expect(notified).toBe(4)
    expect(labels(tree, "a.b")).toEqual(["x"])
  })

  test("a claim needs exactly one placement, and a claim or a mount a path of non-empty names", () => {
    const tree = new SlotTree<string, Slots>()
    const owner = tree.owner("x")
    expect(() => owner.claim({ append: "a", before: "a", render: render("x") } as never)).toThrow("exactly one")
    for (const path of ["", ".", ".a", "a.", "a..b"]) {
      expect(() => owner.claim({ append: path, render: render("x") } as never)).toThrow(`"${path}" is not a slot path`)
      expect(() => tree.mount(path as never)).toThrow(`"${path}" is not a slot path`)
    }
    expect(tree.resolution()).toEqual({ placed: new Map(), suppressed: [], degraded: [] })
  })

  test("reportError calls onError with the claim, the phase and an Error", () => {
    const seen: unknown[] = []
    const tree = new SlotTree<string, Slots>({ onError: (event) => seen.push(event) })
    tree.mount("a")
    const claim = { append: "a" as const, render: render("x") }
    tree.owner("x").claim(claim)
    const event = tree.reportError(tree.placed("a").append[0]!, "a", "broken")
    tree.reportError(tree.placed("a").append[0]!, "a", "no placeholder", "placeholder")
    expect(seen).toEqual([
      { owner: "x", path: "a", claim, phase: "render", error: new Error("broken") },
      { owner: "x", path: "a", claim, phase: "placeholder", error: new Error("no placeholder") },
    ])
    expect(seen[0]).toBe(event)
  })
})
