# API history

Each `<version>.txt` file records how the API of the published `@opentui/*` packages changed in that release. The
documentation site reads these files to show when each feature was added, changed, deprecated, or removed.

A file exists for every stable release. A release without API changes has a file with only the header.

## Format

```
base 0.5.14
- @opentui/core: method DiffRenderable.destroyRecursively(): void
+ @opentui/core: protected method DiffRenderable.destroySelf(): void
- @opentui/solid: method SlotRenderable.getSlotChild(parent: BaseRenderable): TextSlotRenderable | LayoutSlotRenderable
+ @opentui/solid: method SlotRenderable.getSlotChild(parent: BaseRenderable): LayoutSlotRenderable | TextSlotRenderable
```

The first line names the release that the file is relative to: `base <version>`, or `base none` for 0.1.0. Usually
the base is the previous release. A patch of an older line names the release it was made from.

Each other line adds (`+`) or removes (`-`) one feature. A changed signature is a `-` line and a `+` line with the
same key. The API of a release is the API of its base, without the `-` lines, with the `+` lines.

Lines are sorted by key, then `-` before `+`, then by text. A key is `<module>: <kind> <name>`.

## Features

```
<module>: [<modifier> ...]<kind> <name><signature>
```

- `<module>` is the npm specifier of an entry point, such as `@opentui/core` or `@opentui/core/testing`. Each subpath
  of a package's `exports` map with a `types` target is an entry point. A feature exported by two entry points has a
  line for each.
- `<modifier>` is `deprecated` (JSDoc `@deprecated`), `static`, `protected`, `abstract`, or `readonly`, in that order.
- `<kind>` is `class`, `interface`, `type`, `function`, `const`, `let`, `enum`, `enum-member`, `namespace`,
  `constructor`, `method`, `property`, `call`, `construct`, `index`, or `reexport`.
- `<name>` is the export name. A member name includes its owner: `CliRenderer.suspend`, `Yoga.Node.create`. A
  constructor, call, construct, or index signature uses the owner's name. A default export is `default`.
- `<signature>` is the declaration syntax after the name, from the published `.d.ts` files. Comments are removed,
  whitespace is collapsed, and `import("…").X` is written as `X`.

Members are the own members of a class or interface. Inherited members are not repeated; the `extends` clause is on
the class line. Private, `#private`, and `@internal` members are left out. So are public members whose name starts
with `_`. Protected members, including `_` names, are API because users subclass renderables. Getters and setters
are properties; a getter without a setter is `readonly`. Each overload has its own line.

An `export * as X` of a module in the package records `namespace X` and its members as `X.member`. An export from
another package records only the export: `namespace THREE from "three"`, `reexport createElement from "react"`, or
`reexport * from "react"`. A renamed export from another package ends with `as <original name>`.

## Commands

Run these from the repository root.

- `bun packages/web/scripts/api.ts release <version>` writes `api/<version>.txt`: the difference between the latest
  file's API and the API of the source tree. Run it when the release version is set. It does not overwrite a file
  with different contents. Pass `--base <version>` for a patch of an older line.
- `bun packages/web/scripts/api.ts diff` prints the file that a release of the source tree would add.
- `bun packages/web/scripts/api.ts current` prints every feature of the source tree.
- `bun packages/web/scripts/api.ts check` validates the files.
- `bun packages/web/scripts/api.ts backfill [--from <version>] [--to <version>]` writes the files of published
  releases from their npm tarballs. It rewrites only files that changed. Run it after a change to the extractor.

The source commands run `tsc` declaration emit for each package into a temporary directory, with the exports map that
the package's `scripts/build.ts` publishes. They do not run the package builds. The extractor reads those
declarations in the same way as a tarball, so a source tree at a release tag gives the API of that release.
