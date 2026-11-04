import { expect, test } from "bun:test"

import { UNRELEASED, type ChannelApi } from "./api-docs"
import { featureKey, parseFeature } from "./api-history"
import { apiModules } from "./api-reference"

function channelApi(since: Record<string, string>): ChannelApi {
  const features = Object.keys(since).map(parseFeature)
  return {
    versions: ["0.5.0", "0.5.3"],
    features,
    keys: new Map(
      features.map((feature) => [
        featureKey(feature),
        { key: featureKey(feature), since: since[feature.line]!, changedIn: [] },
      ]),
    ),
    changes: () => [],
    size: () => ({ added: 0, removed: 0 }),
  }
}

test("exports have labels after the module's first release, and struct fields are in layout order", async () => {
  const modules = await apiModules(
    channelApi({
      "@opentui/core: class Box": "0.5.0",
      "@opentui/core: function later(): void": "0.5.3",
      "@opentui/core: function next(): void": UNRELEASED,
      "opentui.h: struct ot_handle": UNRELEASED,
      "opentui.h: field ot_handle.context_id: uint64_t, offset 0": UNRELEASED,
      "opentui.h: field ot_handle.generation: uint32_t, offset 12": UNRELEASED,
      "opentui.h: field ot_handle.slot: uint32_t, offset 8": UNRELEASED,
    }),
  )
  expect(
    modules.map((module) => ({
      slug: module.slug,
      exports: module.exports.map((entry) => ({
        name: entry.name,
        label: entry.label,
        members: entry.members.map((member) => [member.feature.name, member.label]),
      })),
    })),
  ).toEqual([
    {
      slug: "core",
      exports: [
        { name: "Box", label: undefined, members: [] },
        { name: "later", label: "0.5.3", members: [] },
        { name: "next", label: UNRELEASED, members: [] },
      ],
    },
    {
      // No release has the module yet, so its exports have no labels.
      slug: "c",
      exports: [
        {
          name: "ot_handle",
          label: undefined,
          members: [
            ["ot_handle.context_id", undefined],
            ["ot_handle.slot", undefined],
            ["ot_handle.generation", undefined],
          ],
        },
      ],
    },
  ])
})
