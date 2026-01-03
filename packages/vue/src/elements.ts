import {
  ASCIIFontRenderable,
  BoxRenderable,
  InputRenderable,
  MarkdownRenderable,
  SelectRenderable,
  TabSelectRenderable,
  TextRenderable,
  ScrollBoxRenderable,
} from "@opentui/core"

export const elements = {
  asciiFontRenderable: ASCIIFontRenderable,
  boxRenderable: BoxRenderable,
  inputRenderable: InputRenderable,
  markdownRenderable: MarkdownRenderable,
  selectRenderable: SelectRenderable,
  tabSelectRenderable: TabSelectRenderable,
  textRenderable: TextRenderable,
  scrollBoxRenderable: ScrollBoxRenderable,
}
export type Element = keyof typeof elements
