import { promises as fs } from "node:fs"
import { basename, extname, relative, resolve } from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"
import type { ContentEntryType } from "astro"
import type { Loader, LoaderContext } from "astro/loaders"

type PackageLoaderContext = LoaderContext & { entryTypes: Map<string, ContentEntryType> }

export function packageLoader(): Loader {
  return {
    name: "opentui-package-loader",
    async load(loaderContext) {
      const context = loaderContext as PackageLoaderContext
      const localDirectory = new URL("content/packages/", context.config.srcDir)
      // The deployment sets OPENTUI_INDEX_DIR in the workflow environment; local
      // development can set it in packages/web/.env, which Vite loads.
      const externalValue = process.env.OPENTUI_INDEX_DIR ?? import.meta.env.OPENTUI_INDEX_DIR
      const directories: URL[] = [localDirectory]

      if (!externalValue) {
        context.logger.info("OPENTUI_INDEX_DIR is not set; loading first-party package entries only.")
      } else {
        const externalDirectory = pathToFileURL(`${resolve(externalValue)}/`)
        if (await exists(externalDirectory)) {
          directories.push(externalDirectory)
        } else {
          context.logger.warn(`OPENTUI_INDEX_DIR does not exist: ${fileURLToPath(externalDirectory)}`)
        }
      }

      const loadAll = async () => {
        const files = (await Promise.all(directories.map(readMdxFiles)))
          .flat()
          .toSorted((a, b) => a.href.localeCompare(b.href))
        const entries = await Promise.all(files.map((file) => readEntry(file, context)))
        const pathsById = new Map<string, string>()

        for (const entry of entries) {
          const previous = pathsById.get(entry.id)
          if (previous) throw new Error(`Duplicate package id "${entry.id}" in ${previous} and ${entry.filePath}`)
          pathsById.set(entry.id, entry.filePath)
        }

        context.store.clear()
        for (const entry of entries) context.store.set(entry)
      }

      await loadAll()

      if (context.watcher) {
        for (const directory of directories) context.watcher.add(fileURLToPath(directory))
        const reload = (file: string) => {
          if (extname(file) !== ".mdx" || !directories.some((directory) => file.startsWith(fileURLToPath(directory))))
            return
          void loadAll().catch((error) => context.logger.error(error instanceof Error ? error.message : String(error)))
        }
        context.watcher.on("add", reload)
        context.watcher.on("change", reload)
        context.watcher.on("unlink", reload)
      }
    },
  }
}

async function readEntry(file: URL, context: PackageLoaderContext) {
  const entryType = context.entryTypes.get(".mdx")
  if (!entryType) throw new Error("The package loader requires the @astrojs/mdx integration")

  const contents = await fs.readFile(file, "utf8")
  const { body, data } = await entryType.getEntryInfo({ contents, fileUrl: file })
  const absolutePath = fileURLToPath(file)
  const filename = basename(absolutePath, ".mdx")
  if (data.id !== filename) {
    throw new Error(`${absolutePath}: frontmatter id must match filename "${filename}"`)
  }

  const filePath = relative(fileURLToPath(context.config.root), absolutePath)
  return {
    id: filename,
    data: await context.parseData({ id: filename, data, filePath: absolutePath }),
    body,
    filePath,
    digest: context.generateDigest(contents),
    deferredRender: true,
  }
}

async function readMdxFiles(directory: URL): Promise<URL[]> {
  if (!(await exists(directory))) return []
  const entries = await fs.readdir(directory, { withFileTypes: true })
  return entries
    .filter((entry) => entry.isFile() && entry.name.endsWith(".mdx"))
    .map((entry) => new URL(entry.name, directory))
}

async function exists(path: URL): Promise<boolean> {
  return fs.stat(path).then(
    () => true,
    () => false,
  )
}
