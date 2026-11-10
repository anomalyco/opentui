import { TextAttributes } from "./types.js"
import { Renderable } from "./Renderable.js"

export function createTextAttributes({
  bold = false,
  italic = false,
  underline = false,
  dim = false,
  blink = false,
  inverse = false,
  reverse = false,
  hidden = false,
  strikethrough = false,
}: {
  bold?: boolean
  italic?: boolean
  underline?: boolean
  dim?: boolean
  blink?: boolean
  inverse?: boolean
  reverse?: boolean
  hidden?: boolean
  strikethrough?: boolean
} = {}): number {
  let attributes = TextAttributes.NONE

  if (bold) attributes |= TextAttributes.BOLD
  if (italic) attributes |= TextAttributes.ITALIC
  if (underline) attributes |= TextAttributes.UNDERLINE
  if (dim) attributes |= TextAttributes.DIM
  if (blink) attributes |= TextAttributes.BLINK
  if (inverse || reverse) attributes |= TextAttributes.INVERSE
  if (hidden) attributes |= TextAttributes.HIDDEN
  if (strikethrough) attributes |= TextAttributes.STRIKETHROUGH

  return attributes
}

// Link attribute helpers (bits 8-31 encode link_id)
const ATTRIBUTE_BASE_MASK = 0xff
const LINK_ID_SHIFT = 8
const LINK_ID_PAYLOAD_MASK = 0xffffff

export function attributesWithLink(baseAttributes: number, linkId: number): number {
  const base = baseAttributes & ATTRIBUTE_BASE_MASK
  const linkBits = (linkId & LINK_ID_PAYLOAD_MASK) << LINK_ID_SHIFT
  return base | linkBits
}

export function getLinkId(attributes: number): number {
  return (attributes >>> LINK_ID_SHIFT) & LINK_ID_PAYLOAD_MASK
}

// For debugging purposes
export function visualizeRenderableTree(renderable: Renderable, maxDepth: number = 10): void {
  function buildTreeLines(
    node: Renderable,
    prefix: string = "",
    parentPrefix: string = "",
    isLastChild: boolean = true,
    depth: number = 0,
  ): string[] {
    if (depth >= maxDepth) {
      return [`${prefix}${node.id} ... (max depth reached)`]
    }

    const lines: string[] = []
    const children = node.getChildren()

    // Add current node
    lines.push(`${prefix}${node.id}`)

    if (children.length > 0) {
      const lastChildIndex = children.length - 1

      children.forEach((child, index) => {
        const childIsLast = index === lastChildIndex
        const connector = childIsLast ? "└── " : "├── "
        const childPrefix = parentPrefix + (isLastChild ? "    " : "│   ")
        const childLines = buildTreeLines(child, childPrefix + connector, childPrefix, childIsLast, depth + 1)
        lines.push(...childLines)
      })
    }

    return lines
  }

  const treeLines = buildTreeLines(renderable)
  console.log("Renderable Tree:\n" + treeLines.join("\n"))
}
