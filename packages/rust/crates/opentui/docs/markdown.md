# Markdown parity with Core

`Markdown` (`src/widget/markdown.rs`) should show what OpenTUI Core's
`MarkdownRenderable` shows, as the OpenCode TUI configures it:

```tsx
<markdown
  syntaxStyle={syntax()}
  renderBlock={plugins.markdown()}
  content={text}
  streaming={!completed}
  tableOptions={{ style: "grid", cellPaddingX: 1 }}
  conceal={markdownMode === "rendered"}
  fg={theme.markdown.text}
  bg={theme.background.base}
/>
```

Both run on the native Markdown engine: it parses the document once and
writes paragraphs and headings to their text nodes; each binding builds its
own widgets per block. The goal is the same frame in both.

The API changes are additive.

## Conceal

`Markdown::conceal(bool)`, on by default as in Core. On, the widget shows
rendered text, as today. Off, it shows the Markdown source of each block, with
the styles still applied:

- Headings keep their `#` run, emphasis its `*`, `_`, and `~~`, code spans their
  backticks, links `[label](url)`, autolinks `<url>`, and images
  `![alt](url)`. Escapes keep their backslash.
- List markers, quote bars, rules, code fences, and table borders look the same
  in both modes, as in Core: Core hides fences and `>` even in source mode.

Both modes keep a paragraph's line breaks, as Core does: chat models break
lines on purpose, and Core shows those breaks.

Links follow Core when concealed: a link whose label differs from its URL shows
` (url)` after the label unless the terminal supports OSC 8 hyperlinks. Images
show their alt text, or `image`.

## Code-block renderers

`Markdown::code_block_renderer(language, render)` registers a renderer for
fences whose info string resolves to `language` through
`syntax::filetype_for_info_string`, as Core's
`createMarkdownCodeBlockRenderer` does. OpenCode's LaTeX and Mermaid plugins
need this hook.

```rust
pub struct CodeBlock<'a> {
    pub app: &'a App,
    pub language: &'a str,
    /// `math` for display math.
    pub info: &'a str,
    pub code: &'a str,
    /// Whether the closing fence or math line has arrived.
    pub closed: bool,
    pub conceal: bool,
    pub streaming: bool,
    /// The widget this renderer returned for this block before the block changed.
    pub previous: Option<&'a AnyWidget>,
}
```

The renderer returns `Some(widget)` to replace the default `Code`, or `None` to
keep it. When a streamed block changes, the widget calls the renderer again
with the widget it returned last time. Returning that same widget keeps it in
place; Core gives the renderer only a block id for that, which Mermaid uses to
keep its last good diagram. `remove_code_block_renderer(language)` removes one.
Registering or removing a renderer rebuilds the code blocks only.

## Math

`Markdown::extensions(&[MarkdownExtension::Math])` turns on Core's math
extension; it is off by default, so `$` is text. The native engine parses it:
`$$` and `\[` display blocks reach a code-block renderer for `math` (as Core's
`lang: "math"` code token, with `closed`), and show their TeX as plain code
without one. Inline `$…$` and `\(…\)` reach the inline hook as
`InlineSpan::math`. A `$` that may still turn out to be text, such as currency,
stays text until the engine decides it.

## Inline hooks

`Markdown::inline_hook(hook)` is the Rust form of Core's per-block chunk
callback (`_linkifyMarkdownChunks`), which OpenCode replaces to show session IDs
as titled links. It gets the inline spans of each paragraph, heading and table
cell, in lists and quotes too, and returns the spans to show. Code blocks and
code-block renderers never reach it, as in Core. Table cells show the spans the
hook returns but take no click targets; `InlineContext::table_cell` is true when
the spans are one table cell's content, and false for every other block.

```rust
#[non_exhaustive] // build one with `InlineSpan::from(span)`
pub struct InlineSpan {
    pub span: Span<'static>,
    /// A code span (`markup.raw`).
    pub code: bool,
    /// What a click on the span means to the app. Never sent to the terminal.
    pub target: Option<String>,
    /// Inline math's TeX, without delimiters (with `MarkdownExtension::Math`).
    pub math: Option<String>,
}

pub struct InlineContext<'a> {
    pub source: &'a str,
    pub conceal: bool,
    pub syntax: &'a SyntaxTheme,
    /// The spans are one table cell's content.
    pub table_cell: bool,
}
```

The hook runs when a block is built or changes, so a streamed `append` runs it
only for the blocks the new text changed. `rerun_inline_hook(select)` runs it again
for the top-level blocks with a paragraph, heading or table cell whose source
`select` accepts, without parsing the document again, for a change only the hook knows
about, such as a new session title; it does nothing without a hook.
`target_at(x, y)` returns the target of the span the last frame drew at a screen
cell, for the app's mouse handler. Native code answers where: the hit grid names
the text at the cell, and `ot_scene_get_text_byte_at` names the byte of the
grapheme drawn there, so padding, covered cells and text not yet painted have no
target. Selecting and copying take the text the hook returned, as Core's do.

Where it differs from Core's callback:

- The spans come after link detection, with `span.link` set. Core's callback
  replaces `detectLinks`, and OpenCode calls it itself. The Rust widget finds
  links while it parses inline text, so there is no separate pass to hand over;
  a hook can still clear `span.link`.
- A span says whether it is a code span instead of handing over tree-sitter
  highlights and source ranges, which the Rust widget does not have for prose.
- Core has no click or re-run API: OpenCode maps clicks through each block's line
  layout and re-highlights blocks by resetting their callback. Rust apps cannot
  reach the block widgets, so `target_at` and `rerun_inline_hook` do that work.

## Streaming

`Markdown::streaming(bool)`, off by default. While it is on, an update reparses
only the source after the last blocks known to be complete, as Core's
`parseMarkdownIncremental` does with trailing unstable tokens: a block is
complete when the source up to the next block's start is unchanged, and the
last complete block is reparsed anyway. The widgets of earlier blocks
are neither compared nor touched. Turning streaming off reparses everything
once, so the final document equals a one-shot parse.

`append` works in both modes. Without streaming it reparses the document and
keeps the widgets of unchanged blocks, as today.

## Table options

`Markdown::table_options(MarkdownTableOptions)` mirrors Core's
`MarkdownTableOptions`: `style` (`Grid` or `Columns`), `width_mode`,
`column_fitter`, `wrap`, `cell_padding_x`, `cell_padding_y`, `borders`,
`outer_border`, `border_style`, `border_color`, and `selectable`, each `None`
for the style's default. `Grid` has borders and fills the width; `Columns` has
no borders, fits the content, and puts two cells between columns. The default
style is `Grid`, which the widget draws today. Core defaults to `Columns` in
top-level mode, but OpenCode always asks for `Grid`.

## Scope styles

`Markdown::scope_styles(true)` styles text through the syntax theme, as Core
styles it through its `syntaxStyle`: headings by `markup.heading.1` to
`markup.heading.6`, then `markup.strong`, `markup.italic`,
`markup.strikethrough`, `markup.raw`, `markup.link`, `markup.link.label`,
`markup.link.url`, `markup.list`, `markup.quote`, `string.escape`, and
`default` for plain text. Rules and quote bars take the `conceal` color. Nested
styles patch the style around them, as overlapping tree-sitter captures do. A
link's `]` and the space before a concealed link's URL keep the text style:
Core's query captures `]` as `markup.link.bracket.close`, which its lookup does
not resolve through `markup.link`. Bare URLs take `markup.link.label`, as
Core's link detection gives them. A scope the theme does not style falls back
to `MarkdownColors`. Off by default, so the colors alone style text.

## Block layout

The widget already lays out blocks as Core's top-level mode does: one widget
per top-level block, a blank row between blocks. These change to match Core:

- Bullets are `-` at every depth; ordered markers are right-aligned to the
  widest number.
- Code blocks lose their one-cell side padding, so code lines start where text
  starts.
- Concealed images lose the picture emoji.
- Table headers take the heading color, as Core's take `markup.heading`.
- Table columns align as their delimiter row says (`:-:` centered, `-:`
  right), header included, as in Core.

## Deviations from Core

- Task items keep their state: `- ☐ todo` and `- ☑ done` when concealed,
  `- [ ] todo` when not. Core drops the checkbox, so done and open items look
  the same.
- Concealed escapes drop their backslash: `\*` shows `*`. Core's tree-sitter
  queries do not conceal escapes, which shows the backslash in rendered text.
- Quotes hold rendered blocks, so a list in a quote is a list. Core shows the
  quote's text as highlighted Markdown source.
- Setext headings show as ATX headings in source mode.
- Hyperlink support is read on each update, which rebuilds every block when it
  changed. Core also rebuilds link text the moment the terminal reports its
  capabilities; the Rust widget waits for its next update.

## Proof

Core and the Rust crate share one Markdown corpus,
`packages/core/src/renderables/markdown.conformance.json`: the CommonMark and
GFM spec examples with their HTML, the cases where the two parsers differed,
and whole documents. `src/widget/markdown.rs` checks its block tree against
each row's HTML and its streamed blocks against a fresh parse; rows where it
disagrees with the spec are listed in the row.

Its `fixture` rows with frames here are headings, lists, code fences, tables,
links, emphasis, quotes and rules. `tests/fixtures/markdown/render.ts` renders
each with `@opentui/core` in `createTestRenderer` at 60 columns, as OpenCode
configures it, with conceal on and off, into `<case>.<mode>.txt`. It also checks
that Core's streamed frame, in chunks of 7 characters, equals the one-shot
frame. `tests/markdown.rs` renders the same rows with the Rust widget, one-shot
and streamed in chunks, and compares the frames with Core's, except where a
deviation above applies.
