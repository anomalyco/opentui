import { beforeAll, describe, expect, test } from "bun:test"

import { buildDocsIndex, getPrevNextDocSequences } from "./docs-index"

describe("documentation index", () => {
  let index: Awaited<ReturnType<typeof buildDocsIndex>>

  beforeAll(async () => {
    index = await buildDocsIndex()
  })

  test("uses authored navigation placement instead of source directories", () => {
    expect(index.pagesBySlug["bindings/react"].section).toBe("frameworks")
    expect(index.pagesBySlug["reference/ssh"].section).toBe("integrations")
    expect(index.pagesBySlug["core-concepts/testing"].section).toBe("test-debug")

    const componentOverview = index.pagesBySourceId["components/overview"]
    expect(componentOverview.slug).toBe("components")
    expect(componentOverview.url).toBe("/docs/components")
    expect(index.pagesByUrl["/docs/components"]).toBe(componentOverview)
  })

  test("keeps component groups static and advanced pages out of primary navigation", () => {
    const components = index.sections.find((section) => section.id === "components")

    expect(components?.pages.find((page) => page.slug === "components/input")?.group).toBe("Input and selection")
    expect(components?.pages.find((page) => page.slug === "components/embedded-terminal")?.group).toBe(
      "Graphics and media",
    )
    expect(components?.pages.some((page) => page.slug === "components/time-to-first-draw")).toBe(false)
    expect(index.pagesBySlug["components/time-to-first-draw"].primaryNav).toBe(false)
  })

  test("publishes the maintained rendering pipeline", () => {
    expect(index.pagesBySlug["core-concepts/rendering-pipeline"].draft).toBe(false)
    expect(index.pagesBySlug["core-concepts/rendering-pipeline"].primaryNav).toBe(false)
  })

  test("uses named learning sequences instead of the global sidebar order", () => {
    const [{ prev, next, sequence }] = getPrevNextDocSequences(index, "bindings/react")

    expect(sequence?.id).toBe("react")
    expect(prev?.slug).toBe("getting-started/quickstart")
    expect(next?.slug).toBe("components")
  })

  test("resolves complete authored metadata for every published page", () => {
    for (const page of index.pages) {
      expect(page.canonicalSection.length).toBeGreaterThan(0)
      expect(page.pageType.length).toBeGreaterThan(0)
      expect(page.status.length).toBeGreaterThan(0)
      expect(page.packages.length).toBeGreaterThan(0)
      expect(page.runtimes.length).toBeGreaterThan(0)
      expect(page.availability.core.length).toBeGreaterThan(0)
      expect(page.availability.react.length).toBeGreaterThan(0)
      expect(page.availability.solid.length).toBeGreaterThan(0)

      if (page.pageType === "component-reference") {
        expect(page.component?.purpose.length).toBeGreaterThan(0)
        expect(page.component?.coreRenderable.length).toBeGreaterThan(0)
        expect(page.component?.react.length).toBeGreaterThan(0)
        expect(page.component?.solid.length).toBeGreaterThan(0)
      }
    }
  })
})
