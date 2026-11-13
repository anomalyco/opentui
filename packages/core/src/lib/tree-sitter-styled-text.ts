import type { TextChunk } from "../text-buffer.js"
import { StyledText } from "./styled-text.js"
import { SyntaxStyle, type StyleDefinition } from "../syntax-style.js"
import { TreeSitterClient } from "./tree-sitter/client.js"
import type { SimpleHighlight } from "./tree-sitter/types.js"
import { createTextAttributes } from "../utils.js"
import { registerEnvVar, env } from "./env.js"

registerEnvVar({ name: "OTUI_TS_STYLE_WARN", default: false, description: "Enable warnings for missing syntax styles" })

interface TextChunkOptions {
  enabled?: boolean
  baseHighlight?: string
  ranges?: Array<{ start: number; end: number }>
  /** Receives, per chunk, the style names it merges in order (a native group set). */
  names?: string[][]
}

interface Boundary {
  offset: number
  type: "start" | "end"
  highlightIndex: number
}

function getSpecificity(group: string): number {
  return group.split(".").length
}

function shouldSuppressInInjection(group: string, meta: any): boolean {
  if (meta?.isInjection) {
    return false
  }

  // Check if this is a parent block that should be suppressed
  // TODO: This is language/highlight specific,
  // not generic enough. Needs a more generic solution.
  // The styles need to be more like a stack that gets merged
  // and for a container with injections we just don't push that container style
  return group === "markup.raw.block"
}

export function treeSitterToTextChunks(
  content: string,
  highlights: SimpleHighlight[],
  syntaxStyle: SyntaxStyle,
  options?: TextChunkOptions,
): TextChunk[] {
  const chunks: TextChunk[] = []
  const ranges = options?.ranges
  const defaultStyle = syntaxStyle.getStyle("default")
  const concealEnabled = options?.enabled ?? true
  const baseStyle = options?.baseHighlight ? syntaxStyle.getStyle(options.baseHighlight) : undefined

  const injectionContainerRanges: Array<{ start: number; end: number }> = []
  const boundaries: Boundary[] = []

  for (let i = 0; i < highlights.length; i++) {
    const [start, end, , meta] = highlights[i]
    if (start === end) continue // Skip zero-length ranges
    if (meta?.containsInjection) {
      injectionContainerRanges.push({ start, end })
    }
    boundaries.push({ offset: start, type: "start", highlightIndex: i })
    boundaries.push({ offset: end, type: "end", highlightIndex: i })
  }

  // Sort boundaries by offset, with ends before starts at same offset
  // This ensures we close old ranges before opening new ones at the same position
  boundaries.sort((a, b) => {
    if (a.offset !== b.offset) return a.offset - b.offset
    if (a.type === "end" && b.type === "start") return -1
    if (a.type === "start" && b.type === "end") return 1
    return 0
  })

  const activeHighlights = new Set<number>()
  let currentOffset = 0

  for (let i = 0; i < boundaries.length; i++) {
    const boundary = boundaries[i]

    if (currentOffset < boundary.offset && activeHighlights.size > 0) {
      const segmentText = content.slice(currentOffset, boundary.offset)

      const activeGroups: Array<{ group: string; meta: any; index: number }> = []
      for (const idx of activeHighlights) {
        const [, , group, meta] = highlights[idx]
        activeGroups.push({ group, meta, index: idx })
      }

      // Check if any active highlight has a conceal property
      // Priority: 1. Check meta.conceal first 2. Check group === "conceal" or starts with "conceal."
      const concealHighlight = concealEnabled
        ? activeGroups.find(
            (h) => h.meta?.conceal !== undefined || h.group === "conceal" || h.group.startsWith("conceal."),
          )
        : undefined

      if (concealHighlight) {
        let replacementText = ""

        if (concealHighlight.meta?.conceal !== undefined) {
          // If meta.conceal is set, use it (this would come from (#set! conceal "...") if supported)
          replacementText = concealHighlight.meta.conceal
        } else if (concealHighlight.group === "conceal.with.space") {
          // Special group name means replace with space
          replacementText = " "
        }

        if (replacementText) {
          chunks.push({
            __isChunk: true,
            text: replacementText,
            fg: defaultStyle?.fg,
            bg: defaultStyle?.bg,
            attributes: createTextAttributes(defaultStyle),
          })
          ranges?.push({ start: currentOffset, end: boundary.offset })
        }
      } else {
        const insideInjectionContainer = injectionContainerRanges.some(
          (range) => currentOffset >= range.start && currentOffset < range.end,
        )

        // Filter out highlights that should be suppressed
        // Suppress highlights when we're inside an injection container
        const validGroups = activeGroups.filter((h) => {
          // If we're inside an injection container, suppress all markup.raw.block highlights
          // This includes both the container itself and any nested markup.raw.block
          if (insideInjectionContainer && shouldSuppressInInjection(h.group, h.meta)) {
            return false
          }
          return true
        })

        // Sort groups by specificity (least to most), then by index (earlier to later)
        // This ensures we merge styles in the correct order: parent styles first, then child overrides
        const sortedGroups = validGroups.sort((a, b) => {
          const aSpec = getSpecificity(a.group)
          const bSpec = getSpecificity(b.group)
          if (aSpec !== bSpec) return aSpec - bSpec // Lower specificity first
          return a.index - b.index // Earlier index first
        })

        // Merge all active styles in order (like CSS cascade)
        // Later/more specific styles override earlier/less specific ones
        const mergedStyle: StyleDefinition = baseStyle ? { ...baseStyle } : {}

        for (const { group } of sortedGroups) {
          let styleForGroup = syntaxStyle.getStyle(group)

          if (!styleForGroup && group.includes(".")) {
            // Fallback to base scope
            const baseName = group.split(".")[0]
            styleForGroup = syntaxStyle.getStyle(baseName)
          }

          if (styleForGroup) {
            // Merge properties - later styles override earlier ones
            for (const [field, value] of Object.entries(styleForGroup)) {
              if (value !== undefined) Reflect.set(mergedStyle, field, value)
            }
          } else {
            if (group.includes(".")) {
              const baseName = group.split(".")[0]
              if (env.OTUI_TS_STYLE_WARN) {
                console.warn(
                  `Syntax style not found for group "${group}" or base scope "${baseName}", using default style`,
                )
              }
            } else {
              if (env.OTUI_TS_STYLE_WARN) {
                console.warn(`Syntax style not found for group "${group}", using default style`)
              }
            }
          }
        }

        // Use merged style, falling back to default if nothing was merged
        const merged = Object.keys(mergedStyle).length > 0
        const finalStyle = merged ? mergedStyle : defaultStyle
        // A theme that defines neither `markup.strikethrough` nor `markup` strikes it with the default's colors here;
        // native adds only the attribute, so the default goes before it.
        const strikes = (group: string) =>
          group === "markup.strikethrough" &&
          !syntaxStyle.getRegisteredNames().some((name) => name === group || name === "markup")
        options?.names?.push(
          merged ? sortedGroups.flatMap(({ group }) => (strikes(group) ? ["default", group] : [group])) : ["default"],
        )

        chunks.push({
          __isChunk: true,
          text: segmentText,
          fg: finalStyle?.fg,
          bg: finalStyle?.bg,
          attributes: createTextAttributes(finalStyle),
        })
        ranges?.push({ start: currentOffset, end: boundary.offset })
      }
    } else if (currentOffset < boundary.offset) {
      const text = content.slice(currentOffset, boundary.offset)
      const style = baseStyle ?? defaultStyle
      options?.names?.push(["default"])
      chunks.push({
        __isChunk: true,
        text,
        fg: style?.fg,
        bg: style?.bg,
        attributes: createTextAttributes(style),
      })
      ranges?.push({ start: currentOffset, end: boundary.offset })
    }

    if (boundary.type === "start") {
      activeHighlights.add(boundary.highlightIndex)
    } else {
      activeHighlights.delete(boundary.highlightIndex)

      if (concealEnabled) {
        const [, , group, meta] = highlights[boundary.highlightIndex]
        if (meta?.concealLines !== undefined) {
          if (boundary.offset < content.length && content[boundary.offset] === "\n") {
            currentOffset = boundary.offset + 1
            continue
          }
        }

        // TODO: This is also a query specific workaround, needs improvement
        if (meta?.conceal !== undefined) {
          // Skip the next space if we replaced with a space (prevents double spaces like "text] (url)")
          if (meta.conceal === " ") {
            if (boundary.offset < content.length && content[boundary.offset] === " ") {
              currentOffset = boundary.offset + 1
              continue
            }
          }
          // For heading markers specifically, also skip the trailing space
          // The group is just "conceal" for heading markers from the markdown query
          // We need to check if this conceal is NOT from an injection (markdown_inline)
          else if (meta.conceal === "" && group === "conceal" && !meta.isInjection) {
            if (boundary.offset < content.length && content[boundary.offset] === " ") {
              currentOffset = boundary.offset + 1
              continue
            }
          }
        }
      }
    }

    currentOffset = boundary.offset
  }

  if (currentOffset < content.length) {
    const text = content.slice(currentOffset)
    const style = baseStyle ?? defaultStyle
    options?.names?.push(["default"])
    chunks.push({
      __isChunk: true,
      text,
      fg: style?.fg,
      bg: style?.bg,
      attributes: createTextAttributes(style),
    })
    ranges?.push({ start: currentOffset, end: content.length })
  }

  return chunks
}

export interface TreeSitterToStyledTextOptions {
  conceal?: Pick<TextChunkOptions, "enabled">
  baseHighlight?: string
}

export async function treeSitterToStyledText(
  content: string,
  filetype: string,
  syntaxStyle: SyntaxStyle,
  client: TreeSitterClient,
  options?: TreeSitterToStyledTextOptions,
): Promise<StyledText> {
  const result = await client.highlightOnce(content, filetype)
  if ((result.highlights && result.highlights.length > 0) || options?.baseHighlight) {
    const chunks = treeSitterToTextChunks(content, result.highlights ?? [], syntaxStyle, {
      enabled: options?.conceal?.enabled ?? true,
      baseHighlight: options?.baseHighlight,
    })
    return new StyledText(chunks)
  } else {
    const defaultStyle = syntaxStyle.mergeStyles("default")
    const chunks: TextChunk[] = [
      {
        __isChunk: true,
        text: content,
        fg: defaultStyle.fg,
        bg: defaultStyle.bg,
        attributes: defaultStyle.attributes,
      },
    ]
    return new StyledText(chunks)
  }
}
