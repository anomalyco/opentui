use super::{
    AnyWidget, Behavior, Code, ColumnFitter, ColumnWidthMode, Container, Content, Element, Text, TextTable, View,
    Widget, build, handle,
};
use crate::app::App;
use crate::layout::{Edge, Gutter, LayoutProperty};
use crate::native::{
    MarkdownBlock, MarkdownDoc, MarkdownLeaf, MarkdownOptions, MarkdownResult, NodeKind, SyntaxStyle, WrapMode,
};
use crate::style::{Attributes, BorderStyle, Color, Sides, Span, Style};
use crate::syntax::{SyntaxTheme, filetype_for_info_string};
use crate::sys;
use crate::theme::Theme;
use std::cell::{Cell, RefCell};
use std::fmt::Write as _;
use std::hash::{DefaultHasher, Hash, Hasher};
use std::ops::Range;
use std::rc::Rc;
use std::sync::Arc;

/// Colors for rendered Markdown.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct MarkdownColors {
    pub text: Color,
    pub heading: Color,
    pub emphasis: Color,
    pub code: Color,
    pub code_bg: Color,
    pub link: Color,
    pub quote: Color,
    pub marker: Color,
    pub rule: Color,
}

impl MarkdownColors {
    pub fn from_theme(theme: &Theme) -> Self {
        Self {
            text: theme.foreground,
            heading: theme.accent,
            emphasis: theme.foreground,
            code: Color::hex(0xf0c674),
            code_bg: theme.surface,
            link: theme.focus,
            quote: theme.muted,
            marker: theme.accent,
            rule: theme.border,
        }
    }
}

/// The styles of the parts of Markdown, each a patch over the style of the text around it.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) struct MarkdownStyles {
    /// Text outside any other part.
    pub(crate) text: Style,
    pub(crate) headings: [Style; 6],
    pub(crate) table_header: Style,
    pub(crate) strong: Style,
    pub(crate) italic: Style,
    pub(crate) strikethrough: Style,
    pub(crate) code: Style,
    /// A backslash escape.
    pub(crate) escape: Style,
    pub(crate) link_label: Style,
    /// A link's brackets and parentheses.
    pub(crate) link: Style,
    /// A link's URL shown as text.
    pub(crate) link_url: Style,
    /// Inline math's TeX.
    pub(crate) math: Style,
    pub(crate) list: Style,
    pub(crate) quote: Style,
    pub(crate) quote_border: Color,
    pub(crate) rule: Color,
}

impl MarkdownStyles {
    /// The styles from `colors`, or with `syntax`, from its scopes as Core's `MarkdownRenderable` names them, where
    /// a scope the theme does not style takes its style from `colors`.
    pub(crate) fn new(colors: &MarkdownColors, syntax: Option<&SyntaxTheme>) -> Self {
        let link = Style::new().fg(colors.link).underline();
        let heading = Style::new().fg(colors.heading).bold();
        let fallback = Self {
            text: Style::new().fg(colors.text),
            headings: [
                heading.underline(),
                heading,
                Style::new().bold(),
                Style::new().bold(),
                Style::new().bold(),
                Style::new().bold(),
            ],
            table_header: heading,
            strong: Style::new().bold().fg(colors.emphasis),
            italic: Style::new().italic(),
            strikethrough: Style::new().strikethrough(),
            code: Style::new().fg(colors.code).bg(colors.code_bg),
            escape: Style::new(),
            link_label: link,
            link,
            link_url: link,
            math: Style::new(),
            list: Style::new().fg(colors.marker),
            quote: Style::new().fg(colors.quote),
            quote_border: colors.quote,
            rule: colors.rule,
        };
        let Some(syntax) = syntax else { return fallback };
        let scope = |name: &str, fallback: Style| syntax.get(name).unwrap_or(fallback);
        let fg = |name: &str| syntax.get(name).and_then(|style| style.fg);
        let level = |level: usize| scope(&format!("markup.heading.{}", level + 1), fallback.headings[level]);
        Self {
            text: fallback.text.patch(scope("default", Style::new())),
            headings: std::array::from_fn(level),
            table_header: scope("markup.heading", fallback.table_header),
            strong: scope("markup.strong", fallback.strong),
            italic: scope("markup.italic", fallback.italic),
            strikethrough: scope("markup.strikethrough", fallback.strikethrough),
            code: scope("markup.raw", fallback.code),
            escape: scope("string.escape", fallback.escape),
            link_label: scope("markup.link.label", fallback.link_label),
            link: scope("markup.link", fallback.link),
            link_url: scope("markup.link.url", fallback.link_url),
            math: scope("markup.math", fallback.math),
            list: scope("markup.list", fallback.list),
            quote: scope("markup.quote", fallback.quote),
            quote_border: fg("conceal").or_else(|| fg("default")).unwrap_or(fallback.quote_border),
            rule: fg("conceal").unwrap_or(fallback.rule),
        }
    }

    /// Defines the scope names the engine's runs compose (N6): each part's style under Core's name for it, so a bound
    /// node and `read_leaf` style text as these styles do, and a redefinition repaints without a rewrite.
    fn register(&self, style: &SyntaxStyle) -> crate::Result<()> {
        for (level, heading) in self.headings.iter().enumerate() {
            style.register(&format!("markup.heading.{}", level + 1), *heading)?;
        }
        for (name, part) in [
            ("markup.strong", self.strong),
            ("markup.italic", self.italic),
            ("markup.strikethrough", self.strikethrough),
            ("markup.link", self.link),
            ("markup.link.label", self.link_label),
            ("markup.link.url", self.link_url),
            ("markup.raw", self.code),
            ("markup.math", self.math),
            ("string.escape", self.escape),
        ] {
            style.register(name, part)?;
        }
        Ok(())
    }
}

/// A fenced code block for a renderer registered with [`Markdown::code_block_renderer`].
pub struct CodeBlock<'a> {
    pub app: &'a App,
    /// The filetype the fence's info string resolves to: the language the renderer was registered for.
    pub language: &'a str,
    /// The fence's info string, such as `mermaid` or `rust,no_run`, and `math` for display math
    /// ([`MarkdownExtension::Math`]).
    pub info: &'a str,
    pub code: &'a str,
    /// Whether the closing fence (or display math's closing line) has arrived. While a document streams, an open
    /// block may still grow.
    pub closed: bool,
    /// Whether the document conceals Markdown markers. See [`Markdown::conceal`].
    pub conceal: bool,
    /// Whether the document is still streaming, so the block may be incomplete. See [`Markdown::streaming`].
    pub streaming: bool,
    /// The widget the renderer returned for this block before the block changed. Returning it again keeps it in
    /// place, for example to keep showing the last block that rendered while the rest streams in.
    pub previous: Option<&'a AnyWidget>,
}

type CodeBlockRenderer = Rc<dyn Fn(&CodeBlock<'_>) -> Option<AnyWidget>>;

/// A piece of a paragraph's or heading's inline text, as a hook registered with [`Markdown::inline_hook`] gets and
/// returns it.
#[derive(Clone, Debug, PartialEq)]
#[non_exhaustive]
pub struct InlineSpan {
    /// The text and its style. `span.link` is a hyperlink the widget found: a Markdown link, an autolink, or a bare
    /// URL. Terminals that support hyperlinks get it through OSC 8, so set it only to a URL.
    pub span: Span<'static>,
    /// Whether this is a code span, styled as `markup.raw`. Without conceal, its text keeps the backticks.
    pub code: bool,
    /// What a click on this span means to the app, such as an ID; [`Markdown::target_at`] returns it. It never
    /// reaches the terminal.
    pub target: Option<String>,
    /// Inline math, `$…$` or `\(…\)`: its TeX without the delimiters. Only with [`MarkdownExtension::Math`].
    pub math: Option<String>,
}

impl From<Span<'static>> for InlineSpan {
    fn from(span: Span<'static>) -> Self {
        Self { span, code: false, target: None, math: None }
    }
}

/// A syntax the [`Markdown`] parser reads beyond CommonMark and GFM, as Core's `MarkdownOptions.extensions`.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
#[non_exhaustive]
pub enum MarkdownExtension {
    /// `$…$` and `\(…\)` inline math ([`InlineSpan::math`]), and `$$` or `\[` display blocks, which show as code of
    /// the language `math`, so a [`Markdown::code_block_renderer`] for `math` draws them. A `$` that can still turn
    /// out to be text, such as currency, shows as text until it is decided.
    Math,
}

/// The block an inline hook rewrites.
pub struct InlineContext<'a> {
    /// The block's inline Markdown source.
    pub source: &'a str,
    /// Whether the document conceals Markdown markers. See [`Markdown::conceal`].
    pub conceal: bool,
    /// The document's syntax theme, for styles such as `markup.link.url`.
    pub syntax: &'a SyntaxTheme,
    /// Whether the spans are one table cell's content. A cell shows the spans the hook returns but takes no click
    /// targets.
    pub table_cell: bool,
}

type InlineHook = Rc<dyn Fn(Vec<InlineSpan>, &InlineContext<'_>) -> Vec<InlineSpan>>;

/// The click targets of a paragraph or heading: byte ranges of its text, and what each means to the app.
struct Targets {
    ranges: Vec<(Range<usize>, String)>,
    /// The app's frame number when `ranges` arrived: later frames paint them.
    since: u64,
    /// The ranges the frames up to `since` painted.
    painted: Vec<(Range<usize>, String)>,
}

/// The look of Markdown tables. See [`MarkdownTableOptions`].
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Hash)]
pub enum MarkdownTableStyle {
    /// Lines around and between the cells, with columns that fill the width.
    #[default]
    Grid,
    /// No lines, columns as wide as their content, and two cells between columns.
    Columns,
}

/// How a [`Markdown`] document draws tables, as Core's `MarkdownTableOptions`. Each `None` takes the style's
/// default.
#[derive(Clone, Copy, Debug, Default, PartialEq)]
pub struct MarkdownTableOptions {
    pub style: MarkdownTableStyle,
    /// [`ColumnWidthMode::Full`] for [`MarkdownTableStyle::Grid`], [`ColumnWidthMode::Content`] for
    /// [`MarkdownTableStyle::Columns`].
    pub width_mode: Option<ColumnWidthMode>,
    pub column_fitter: Option<ColumnFitter>,
    /// [`WrapMode::Word`] by default.
    pub wrap: Option<WrapMode>,
    /// No padding by default.
    pub cell_padding_x: Option<u32>,
    pub cell_padding_y: Option<u32>,
    /// Lines between the cells: on for [`MarkdownTableStyle::Grid`], off for [`MarkdownTableStyle::Columns`].
    pub borders: Option<bool>,
    /// The line around the table; it follows `borders` by default.
    pub outer_border: Option<bool>,
    pub border_style: Option<BorderStyle>,
    /// The rule color of [`MarkdownColors`] by default.
    pub border_color: Option<Color>,
    /// Whether the mouse selects cell text. On by default.
    pub selectable: Option<bool>,
}

/// The settings blocks render with.
#[derive(Clone, Default)]
struct Options {
    conceal: bool,
    streaming: bool,
    /// Styles text through the syntax theme's scopes.
    scopes: bool,
    table: MarkdownTableOptions,
    /// Renderers by the filetype they render.
    code_blocks: Vec<(String, CodeBlockRenderer)>,
    inline_hook: Option<InlineHook>,
    math: bool,
}

pub(crate) struct MarkdownInner {
    element: Element,
    /// The native document: the source, its blocks, and the paragraphs and headings it writes itself.
    doc: Option<MarkdownDoc>,
    /// The style its leaves draw with, defined from `colors`, `syntax` and `scopes` (N6).
    style: Option<SyntaxStyle>,
    /// Held while a reader borrows the source, so a change from inside the read panics instead of moving it.
    guard: RefCell<()>,
    colors: RefCell<MarkdownColors>,
    syntax: RefCell<Arc<SyntaxTheme>>,
    options: RefCell<Rc<Options>>,
    styles: Cell<MarkdownStyles>,
    /// Every block of the document by index, as last read, with its widget.
    blocks: RefCell<Vec<Shown>>,
    /// Whether the terminal showed hyperlinks at the last change (the engine's `OT_MD_HYPERLINKS`, N5).
    hyperlinks: Cell<bool>,
    /// The code blocks whose renderer ran for a finished document in the last change: ending the stream asks each
    /// one once.
    rendered_code: RefCell<Vec<u32>>,
}

impl Behavior for MarkdownInner {
    fn element(&self) -> &Element {
        &self.element
    }
}

/// A block as last read, and what shows it.
struct Shown {
    block: MarkdownBlock,
    rendered: Option<Rendered>,
    /// A leaf the widget writes itself: the parser output it wrote last, with the inline source when a hook read it,
    /// which an unchanged leaf does not write again.
    written: Option<(MarkdownLeaf, Option<String>)>,
    /// A hash of the spans the widget wrote last: equal spans leave the node as is, so its painted bytes keep
    /// answering clicks.
    content: Option<u64>,
    /// The click targets the inline hook gave a paragraph or heading.
    targets: Option<Targets>,
    /// The widget wrote the text since native code last took the node: when native code writes the leaf again, the
    /// widget binds the node again to hand it over (native code never writes over the widget's text).
    host_wrote: bool,
}

/// A block's widget. Table rows and cells have none: their table shows them.
#[derive(Clone)]
enum Rendered {
    Text(Text),
    Code(View, Code),
    /// A code block from a registered renderer.
    Custom(AnyWidget),
    Table(TextTable),
    /// A rule, quote or list; a quote's and a list's children go inside.
    Other(View),
    Item {
        row: View,
        marker: Text,
        body: View,
        /// The marker's text as last set, so an update that keeps it sets nothing.
        label: Rc<RefCell<String>>,
    },
}

impl Rendered {
    fn widget(&self) -> AnyWidget {
        match self {
            Self::Text(text) => text.as_any(),
            Self::Code(container, _) => container.as_any(),
            Self::Table(table) => table.as_any(),
            Self::Custom(widget) => widget.clone(),
            Self::Other(view) | Self::Item { row: view, .. } => view.as_any(),
        }
    }

    /// Where the block's children go.
    fn container(&self) -> Option<View> {
        match self {
            Self::Other(view) | Self::Item { body: view, .. } => Some(view.clone()),
            _ => None,
        }
    }
}

const PARAGRAPH: u32 = sys::OT_MD_PARAGRAPH;
const HEADING: u32 = sys::OT_MD_HEADING;

fn is_prose(block: &MarkdownBlock) -> bool {
    block.kind == PARAGRAPH || block.kind == HEADING
}

/// The spans of a leaf's parser output, styles and links as native code resolved them. Without `conceal`, math shows
/// its delimiters.
fn leaf_spans(leaf: &MarkdownLeaf, conceal: bool) -> Vec<InlineSpan> {
    let mut at = 0;
    leaf.chunks
        .iter()
        .zip(&leaf.spans)
        .map(|(chunk, span)| {
            let end = at + chunk.byte_count as usize;
            let text = String::from_utf8_lossy(&leaf.bytes[at..end]).into_owned();
            at = end;
            let color = |flag: u32, raw: [u16; 4]| (chunk.flags & flag != 0).then(|| Color::from_raw(raw));
            let style = Style {
                fg: color(sys::OT_SCENE_TEXT_FOREGROUND, chunk.foreground),
                bg: color(sys::OT_SCENE_TEXT_BACKGROUND, chunk.background),
                attributes: Attributes::from_bits(chunk.attributes as u8),
            };
            let mut text = Span::styled(text, style);
            if chunk.flags & sys::OT_SCENE_TEXT_LINK != 0 {
                let url = &leaf.urls[chunk.link_offset as usize..][..chunk.link_byte_count as usize];
                text = text.link(String::from_utf8_lossy(url).into_owned());
            }
            // Stripped by text, so a span without both delimiters can never panic: it is not math.
            let tex = text.content.as_ref();
            let (open, close) = if conceal {
                ("", "")
            } else if tex.starts_with('$') {
                ("$", "$")
            } else {
                ("\\(", "\\)")
            };
            let math = (span & sys::OT_MD_SPAN_MATH != 0)
                .then(|| Some(tex.strip_prefix(open)?.strip_suffix(close)?.to_owned()))
                .flatten();
            InlineSpan { span: text, code: span & sys::OT_MD_SPAN_CODE != 0, target: None, math }
        })
        .collect()
}

/// Rendered Markdown: headings, paragraphs with inline styles and links, nested lists with tasks, quotes, tables,
/// rules, and fenced code with highlighting, laid out as OpenTUI Core lays out a top-level Markdown document.
///
/// It builds native widgets, so text wraps and selects like any [`Text`]. OpenTUI's native Markdown engine parses
/// the document as it streams in with [`Self::append`]: it reads each byte once, updates only the blocks the new text
/// changes, and writes streamed paragraphs and headings to their widgets itself. It follows CommonMark and GitHub's
/// tables, strikethrough, task lists and autolinks, and math with [`Self::extensions`]; HTML shows as its source.
///
/// ```no_run
/// # use opentui::prelude::*;
/// # use opentui::widget::Markdown;
/// # let app = App::new(AppOptions::default())?;
/// let doc = Markdown::new(&app).streaming(true);
/// doc.set_markdown("# Hello\n\nSome **bold** text and a [link](https://opentui.com).");
/// doc.append("\n\n- streamed\n- items");
/// doc.streaming(false);
/// app.root().add(&doc);
/// # Ok::<(), opentui::Error>(())
/// ```
#[derive(Clone)]
pub struct Markdown(Rc<MarkdownInner>);

handle!(Markdown, MarkdownInner);

impl Markdown {
    pub fn new(app: &App) -> Self {
        let colors = MarkdownColors::from_theme(&app.theme());
        let styles = MarkdownStyles::new(&colors, None);
        let context = app.session().context();
        let style = app.report(SyntaxStyle::new(context));
        if let Some(style) = &style {
            app.report(styles.register(style));
        }
        let flags = sys::OT_MD_CONCEAL | if app.hyperlinks() { sys::OT_MD_HYPERLINKS } else { 0 };
        let doc = app.report(MarkdownDoc::new(context, &MarkdownOptions { flags, style: style.as_ref() }));
        let markdown = Self(build(app, NodeKind::Box, |element| MarkdownInner {
            element,
            doc,
            style,
            guard: RefCell::new(()),
            colors: RefCell::new(colors),
            syntax: RefCell::new(Arc::new(SyntaxTheme::from_theme(&app.theme()))),
            options: RefCell::new(Rc::new(Options { conceal: true, ..Options::default() })),
            styles: Cell::new(styles),
            blocks: RefCell::new(Vec::new()),
            hyperlinks: Cell::new(app.hyperlinks()),
            rendered_code: RefCell::default(),
        }));
        markdown.0.element.set_layout(LayoutProperty::Gap(Gutter::Row, 1.into()));
        markdown
    }

    /// Replaces the content. Blocks equal to the ones shown keep their widgets. While the document streams, text
    /// that extends the content costs what appending the new text does.
    pub fn set_markdown(&self, markdown: impl Into<String>) -> Self {
        let markdown = markdown.into();
        self.change(|doc, finish| {
            // A fresh parse of the whole text equals the appended one (the engine's invariant 1).
            let kept = if finish {
                None
            } else {
                let source = doc.source()?;
                markdown.starts_with(source).then_some(source.len())
            };
            let set = match kept {
                Some(len) => doc.append(&markdown[len..])?,
                None => doc.set(&markdown)?,
            };
            Ok(if finish { merge(set, doc.finish()?) } else { set })
        });
        self.clone()
    }

    /// Appends to the content, as for text streamed in chunks.
    pub fn append(&self, markdown: &str) -> Self {
        self.change(|doc, finish| {
            let append = doc.append(markdown)?;
            Ok(if finish { merge(append, doc.finish()?) } else { append })
        });
        self.clone()
    }

    /// A copy of the content. [`Self::with_markdown`] reads it without one.
    pub fn markdown(&self) -> String {
        self.with_markdown(str::to_owned)
    }

    /// Reads the content without copying it, for example to check whether streamed text extends what is shown.
    ///
    /// # Panics
    ///
    /// Panics if `read` changes the content of this widget through [`Self::set_markdown`] or [`Self::append`].
    pub fn with_markdown<R>(&self, read: impl FnOnce(&str) -> R) -> R {
        let _guard = self.0.guard.borrow();
        let source = self.0.doc.as_ref().and_then(|doc| self.app().and_then(|app| app.report(doc.source())));
        read(source.unwrap_or_default())
    }

    pub fn colors(&self, colors: MarkdownColors) -> Self {
        *self.0.colors.borrow_mut() = colors;
        self.restyle();
        self.clone()
    }

    /// The styles for code blocks, which the `tree-sitter` feature highlights as the filetype their fence names:
    /// `rust` in ` ```rust `. It starts as [`SyntaxTheme::from_theme`] for the app's theme.
    pub fn syntax_theme(&self, theme: SyntaxTheme) -> Self {
        *self.0.syntax.borrow_mut() = Arc::new(theme);
        self.restyle();
        self.clone()
    }

    /// Whether to style text through the [`Self::syntax_theme`] scopes Core's Markdown uses, so one theme styles
    /// both prose and code: `markup.heading.1` to `markup.heading.6`, `markup.strong`, `markup.italic`,
    /// `markup.strikethrough`, `markup.raw`, `markup.link`, `markup.link.label`, `markup.link.url`, `markup.math`,
    /// `markup.list`, `markup.quote`, `string.escape`, `default` for plain text, and the `conceal` color for rules and
    /// quote bars. A scope the theme does not style takes its color from [`Self::colors`]. Off by default: text takes
    /// the colors alone.
    pub fn scope_styles(&self, on: bool) -> Self {
        if self.0.options.borrow().scopes != on {
            Rc::make_mut(&mut self.0.options.borrow_mut()).scopes = on;
            self.restyle();
        }
        self.clone()
    }

    /// Whether to hide the Markdown markers and show rendered text, as by default. Off, each block shows its source,
    /// styled: `**bold**`, `` `code` ``, `[label](url)`, and `# ` before headings. List markers, quote bars, rules,
    /// code blocks, and table lines look the same either way, as in Core.
    pub fn conceal(&self, conceal: bool) -> Self {
        if self.0.options.borrow().conceal != conceal {
            Rc::make_mut(&mut self.0.options.borrow_mut()).conceal = conceal;
            self.change_options();
            self.rebuild_all(false);
        }
        self.clone()
    }

    /// Whether the content is still streaming in. While it is, the last line shows as far as it is decided: a line
    /// that may still become a table row, a fence's end or a heading's underline waits for its end. Turning it off
    /// ends the document, so it shows as it would from one [`Self::set_markdown`], and runs the code-block renderers
    /// again with their widgets, because [`CodeBlock::streaming`] changed. Off by default.
    pub fn streaming(&self, streaming: bool) -> Self {
        if self.0.options.borrow().streaming != streaming {
            Rc::make_mut(&mut self.0.options.borrow_mut()).streaming = streaming;
            if streaming {
                // An ended document opens again as a fresh parse of its source (N2).
                self.change(|doc, _| {
                    let source = doc.source()?.to_owned();
                    doc.set(&source)
                });
            } else {
                self.change(|doc, _| doc.finish());
                self.rerun_renderers();
            }
        }
        self.clone()
    }

    /// How tables look. [`MarkdownTableStyle::Grid`] by default.
    pub fn table_options(&self, options: MarkdownTableOptions) -> Self {
        if self.0.options.borrow().table != options {
            Rc::make_mut(&mut self.0.options.borrow_mut()).table = options;
            self.rebuild_all(false);
        }
        self.clone()
    }

    /// Renders fenced code blocks of a language with `render` instead of a [`Code`] widget, as Core's
    /// `createMarkdownCodeBlockRenderer` does: diagrams for `mermaid`, math for `latex`. A fence matches when its
    /// info string resolves to the same filetype through [`filetype_for_info_string`], so `ts` and `typescript`
    /// match each other. `render` returns `None` to keep the default widget. It runs again when the block changes,
    /// with the widget it returned last in [`CodeBlock::previous`].
    pub fn code_block_renderer(
        &self,
        language: &str,
        render: impl Fn(&CodeBlock<'_>) -> Option<AnyWidget> + 'static,
    ) -> Self {
        let language = filetype_for_info_string(language).unwrap_or_else(|| language.to_owned());
        let mut options = self.0.options.borrow_mut();
        let code_blocks = &mut Rc::make_mut(&mut options).code_blocks;
        code_blocks.retain(|(key, _)| *key != language);
        code_blocks.push((language, Rc::new(render)));
        drop(options);
        self.rebuild_all(false);
        self.clone()
    }

    /// Removes the renderer for a language that [`Self::code_block_renderer`] registered.
    pub fn remove_code_block_renderer(&self, language: &str) -> Self {
        let language = filetype_for_info_string(language).unwrap_or_else(|| language.to_owned());
        Rc::make_mut(&mut self.0.options.borrow_mut()).code_blocks.retain(|(key, _)| *key != language);
        self.rebuild_all(false);
        self.clone()
    }

    /// Passes the inline text of every paragraph, heading and table cell, in lists and quotes too, through `hook`
    /// before it is shown, as Core's Markdown passes each prose block's chunks through its chunk callback: to show IDs
    /// as titled links, for example. Code blocks and code-block renderers never reach it.
    ///
    /// `hook` gets the spans in order, each marked when it is a code span or already a link, and returns the spans to
    /// show. A span's [`InlineSpan::target`] makes it clickable for the app through [`Self::target_at`], without a
    /// hyperlink; in a table cell it is ignored. It runs when a block is built or its text changes, so
    /// [`Self::append`] runs it only for the blocks the new text changes; [`Self::rerun_inline_hook`] runs it again
    /// for chosen blocks. Selecting and copying take the text it returns.
    pub fn inline_hook(&self, hook: impl Fn(Vec<InlineSpan>, &InlineContext<'_>) -> Vec<InlineSpan> + 'static) -> Self {
        let had = Rc::make_mut(&mut self.0.options.borrow_mut()).inline_hook.replace(Rc::new(hook)).is_some();
        if had {
            self.rebuild_all(false);
        } else {
            self.change_options();
        }
        self.clone()
    }

    /// The syntax extensions to parse. None by default, so `$` is always text.
    pub fn extensions(&self, extensions: &[MarkdownExtension]) -> Self {
        let math = extensions.contains(&MarkdownExtension::Math);
        if self.0.options.borrow().math != math {
            Rc::make_mut(&mut self.0.options.borrow_mut()).math = math;
            self.change_options();
        }
        self.clone()
    }

    /// Removes the hook [`Self::inline_hook`] registered.
    pub fn remove_inline_hook(&self) -> Self {
        if Rc::make_mut(&mut self.0.options.borrow_mut()).inline_hook.take().is_some() {
            self.change_options();
        }
        self.clone()
    }

    /// Runs the inline hook again for the top-level blocks holding a paragraph, heading or table cell whose inline
    /// source `select` accepts, for a change only the hook knows about, such as a new title for an ID it links. Other
    /// blocks are left alone, and nothing is parsed again; a selected block is built again whole.
    pub fn rerun_inline_hook(&self, select: impl Fn(&str) -> bool) -> Self {
        if self.0.options.borrow().inline_hook.is_none() {
            return self.clone();
        }
        let Some(doc) = &self.0.doc else { return self.clone() };
        let selected: Vec<u32> = {
            let blocks = self.0.blocks.borrow();
            let mut selected = Vec::new();
            let mut top = 0;
            for shown in blocks.iter() {
                let block = &shown.block;
                if block.parent.is_none() {
                    top = block.index;
                }
                let inline = is_prose(block) || block.kind == sys::OT_MD_TABLE_CELL;
                if inline && selected.last() != Some(&top) && doc.read_source(block.index).is_ok_and(|s| select(&s)) {
                    selected.push(top);
                }
            }
            selected
        };
        for top in selected {
            self.rebuild_subtree(top, false);
        }
        self.clone()
    }

    /// The [`InlineSpan::target`] of the span the last frame drew at the screen cell `(x, y)`, as native hit testing
    /// and text layout place it: `None` on padding, on cells something else covers, and on text that changed since
    /// that frame. Call it from a mouse handler to make those spans clickable; hold the `Markdown` weakly there, so
    /// the handler does not keep a removed document alive.
    pub fn target_at(&self, x: u16, y: u16) -> Option<String> {
        // Native code answers both questions: which text the last frame drew at the cell, and which byte of it.
        let app = self.0.element.app()?;
        let hit = app.widget_at(x, y)?;
        let blocks = self.0.blocks.borrow();
        let (text, targets) = blocks.iter().find_map(|shown| match (&shown.rendered, &shown.targets) {
            (Some(Rendered::Text(text)), Some(targets)) if text.id() == hit.id() => Some((text, targets)),
            _ => None,
        })?;
        let byte = text.element().query(|node| node.text_byte_at(i32::from(x), i32::from(y)))?? as usize;
        // The ranges that frame painted, which the newest are once a frame has followed them.
        let ranges = if app.painted_frames() > targets.since { &targets.ranges } else { &targets.painted };
        let (_, target) = ranges.iter().find(|(range, _)| range.contains(&byte))?;
        Some(target.clone())
    }

    fn app(&self) -> Option<App> {
        self.0.element.app()
    }

    /// The engine flags: conceal, the terminal's hyperlinks, math, and a hook on every prose leaf (empty filter).
    fn flags(&self) -> u32 {
        let options = self.0.options.borrow();
        let mut flags = 0;
        if options.conceal {
            flags |= sys::OT_MD_CONCEAL;
        }
        if options.math {
            flags |= sys::OT_MD_MATH;
        }
        if self.0.hyperlinks.get() {
            flags |= sys::OT_MD_HYPERLINKS;
        }
        if options.inline_hook.is_some() {
            flags |= sys::OT_MD_HOOK;
        }
        flags
    }

    /// Whether the widget writes prose leaves itself: with a hook, without conceal, or without hyperlinks the parser's
    /// display is not what shows.
    fn host_writes(&self) -> bool {
        self.flags() & !sys::OT_MD_MATH != sys::OT_MD_CONCEAL | sys::OT_MD_HYPERLINKS
    }

    /// Runs a change on the document and shows what it changed. `finish` says the document does not stream.
    fn change(&self, run: impl FnOnce(&MarkdownDoc, bool) -> crate::Result<MarkdownResult>) {
        let Some(app) = self.app() else { return };
        let Some(doc) = &self.0.doc else { return };
        self.0.rendered_code.borrow_mut().clear();
        let result = {
            let guard = self.0.guard.try_borrow_mut();
            let _guard = guard.expect("the Markdown content changed while it was read");
            // Link text depends on hyperlink support, which the terminal reports after startup (N5).
            let mut options = None;
            if app.hyperlinks() != self.0.hyperlinks.get() {
                self.0.hyperlinks.set(app.hyperlinks());
                let style = self.0.style.as_ref();
                options = app.report(doc.set_options(&MarkdownOptions { flags: self.flags(), style }));
            }
            let streaming = self.0.options.borrow().streaming;
            let result = app.report(run(doc, !streaming));
            match (options, result) {
                (Some(options), Some(result)) => Some(merge(options, result)),
                (options, result) => result.or(options),
            }
        };
        // Showing the change runs hooks and renderers, which may read the content but not change it.
        let _guard = self.0.guard.borrow();
        if let Some(result) = result {
            self.apply(&app, doc, result);
        }
    }

    /// Sends the engine flags after an option change. What the widget wrote under the old options is written again.
    fn change_options(&self) {
        for shown in self.0.blocks.borrow_mut().iter_mut() {
            shown.written = None;
            shown.content = None;
        }
        // The flags as `change` leaves them: it may first take in a new hyperlink capability (N5).
        let style = self.0.style.as_ref();
        self.change(|doc, _| doc.set_options(&MarkdownOptions { flags: self.flags(), style }));
    }

    /// Shows a call's changes: drops the widgets of removed blocks, then builds or updates each listed block.
    fn apply(&self, app: &App, doc: &MarkdownDoc, result: MarkdownResult) {
        let mut refresh = Refresh::default();
        let mut removed = Removed::default();
        if let Some(from) = result.removed_from {
            let mut blocks = self.0.blocks.borrow_mut();
            let at = (from as usize).min(blocks.len());
            removed = Removed { from: at as u32, blocks: blocks.drain(at..).collect(), reusing: true };
        }
        if result.changed > 0
            && let Some(changes) = app.report(doc.read_changes())
        {
            for block in changes {
                self.update(app, doc, block, &mut refresh, &mut removed);
            }
        }
        // The removed widgets nothing took back: only one whose parent stays is attached to a widget that stays.
        for shown in &removed.blocks {
            if let Some(rendered) = &shown.rendered
                && shown.block.parent.is_none_or(|parent| parent < removed.from)
            {
                rendered.widget().detach();
            }
        }
        self.finish_refresh(app, doc, refresh);
        // Native code may have written bound text without listing it.
        app.request_redraw();
    }

    /// Builds a new block's widget, or updates the one shown.
    fn update(&self, app: &App, doc: &MarkdownDoc, block: MarkdownBlock, refresh: &mut Refresh, removed: &mut Removed) {
        let index = block.index as usize;
        let len = self.0.blocks.borrow().len();
        debug_assert!(index <= len, "blocks arrive in preorder");
        if index == len {
            // A text or code block in the place of a removed one of its kind keeps its widget, as an update in
            // place, so clicks keep reaching what the last frame painted there.
            if let Some(mut old) = removed.reuse(&block) {
                if is_prose(&block)
                    && let Some(Rendered::Text(text)) = &old.rendered
                    && let Some(node) = text.element().node()
                {
                    app.report(doc.bind(block.index, node));
                }
                old.block = block.clone();
                self.0.blocks.borrow_mut().push(old);
                if block.kind == sys::OT_MD_CODE {
                    self.update_code(app, doc, &block);
                }
                self.after_change(app, doc, index, refresh);
                return;
            }
            let rendered = self.build_block(app, doc, &block);
            let parent = block.parent;
            self.0.blocks.borrow_mut().push(Shown {
                block,
                rendered: rendered.clone(),
                written: None,
                content: None,
                targets: None,
                host_wrote: false,
            });
            if let Some(rendered) = &rendered {
                self.attach(parent, rendered);
            }
            self.after_change(app, doc, index, refresh);
            return;
        }
        let old_kind = self.0.blocks.borrow()[index].block.kind;
        let rendered = self.0.blocks.borrow()[index].rendered.clone();
        self.0.blocks.borrow_mut()[index].block = block.clone();
        if old_kind != block.kind {
            // A kind change at the same index: a paragraph that becomes a setext heading keeps its text widget.
            let keeps = is_prose(&block) && matches!(rendered, Some(Rendered::Text(_))) && old_kind == PARAGRAPH;
            if !keeps {
                let new = self.build_block(app, doc, &block);
                self.replace(block.parent, rendered.as_ref(), new.as_ref());
                let mut blocks = self.0.blocks.borrow_mut();
                blocks[index].rendered = new;
                blocks[index].written = None;
                blocks[index].content = None;
                blocks[index].targets = None;
            }
        } else if block.kind == sys::OT_MD_CODE {
            self.update_code(app, doc, &block);
        }
        self.after_change(app, doc, index, refresh);
    }

    /// Shows a code block's new content in the widget it has, or in a new one a renderer returns.
    fn update_code(&self, app: &App, doc: &MarkdownDoc, block: &MarkdownBlock) {
        let index = block.index as usize;
        let rendered = self.0.blocks.borrow()[index].rendered.clone();
        let new = self.code_block(app, doc, block, rendered.as_ref());
        if new.as_ref().map(Rendered::widget) != rendered.as_ref().map(Rendered::widget) {
            self.replace(block.parent, rendered.as_ref(), new.as_ref());
        }
        self.0.blocks.borrow_mut()[index].rendered = new;
    }

    /// What a changed block changes besides its own widget: text the widget writes, and the table or list around it.
    fn after_change(&self, app: &App, doc: &MarkdownDoc, index: usize, refresh: &mut Refresh) {
        let (block, rendered) = {
            let blocks = self.0.blocks.borrow();
            (blocks[index].block.clone(), blocks[index].rendered.clone())
        };
        match (block.kind, rendered) {
            (PARAGRAPH | HEADING, Some(Rendered::Text(text))) if self.host_writes() => {
                self.write_prose(app, doc, index, &text, false);
            }
            // Native code writes the text: it has no targets once a frame paints it.
            (PARAGRAPH | HEADING, Some(Rendered::Text(text))) => {
                if std::mem::take(&mut self.0.blocks.borrow_mut()[index].host_wrote)
                    && let Some(node) = text.element().node()
                {
                    app.report(doc.bind(block.index, node));
                }
                self.set_targets(app, index, Vec::new());
            }
            (sys::OT_MD_HTML, Some(Rendered::Text(text))) => {
                if let Some(leaf) = app.report(doc.read_leaf(block.index)) {
                    text.set_text(String::from_utf8_lossy(&leaf.bytes).into_owned());
                }
            }
            (sys::OT_MD_TABLE, _) => refresh.table(block.index),
            (sys::OT_MD_LIST, _) => refresh.list(block.index),
            _ => {}
        }
        // A table shows its rows' cells; a list's gaps and markers follow its items and their blocks.
        if let Some(parent) = block.parent {
            refresh.parent_changed(&self.0.blocks.borrow(), parent);
        }
    }

    fn finish_refresh(&self, app: &App, doc: &MarkdownDoc, refresh: Refresh) {
        for table in refresh.tables {
            self.fill_table(app, doc, table);
        }
        for list in refresh.lists {
            self.update_list(app, doc, list);
        }
    }

    /// The style text in block `index` takes where no part styles it: the text style, under each quote around it.
    fn base(&self, parent: Option<u32>) -> Style {
        let styles = self.0.styles.get();
        let blocks = self.0.blocks.borrow();
        let mut style = styles.text;
        let mut next = parent;
        while let Some(index) = next {
            let Some(shown) = blocks.get(index as usize) else { break };
            if shown.block.kind == sys::OT_MD_QUOTE {
                style = style.patch(styles.quote);
            }
            next = shown.block.parent;
        }
        style
    }

    /// The widget of a block, without its children (they attach as they arrive).
    fn build_block(&self, app: &App, doc: &MarkdownDoc, block: &MarkdownBlock) -> Option<Rendered> {
        let styles = self.0.styles.get();
        let base = self.base(block.parent);
        let rendered = match block.kind {
            PARAGRAPH | HEADING | sys::OT_MD_HTML => {
                let text = Text::new(app, "").fg(base.fg.unwrap_or(self.0.colors.borrow().text));
                text.attributes(base.attributes);
                if is_prose(block) {
                    // The node draws with the doc's style; the doc writes it unless the widget does.
                    if let Some(node) = text.element().node() {
                        app.report(doc.bind(block.index, node));
                    }
                }
                Rendered::Text(text)
            }
            sys::OT_MD_CODE => self.code_block(app, doc, block, None)?,
            sys::OT_MD_RULE => {
                Rendered::Other(View::new(app).border_sides(Sides::TOP).border_color(styles.rule).height(1))
            }
            sys::OT_MD_TABLE => Rendered::Table(self.table(app, base)),
            sys::OT_MD_QUOTE => Rendered::Other(
                View::new(app)
                    .border_sides(Sides::LEFT)
                    .border_color(styles.quote_border)
                    .padding_edge(Edge::Left, 1)
                    .gap(1),
            ),
            sys::OT_MD_LIST => Rendered::Other(View::new(app)),
            sys::OT_MD_ITEM => {
                let marker = Text::new(app, "").shrink(0.0);
                let body = View::new(app).grow(1.0);
                let row = View::new(app).row().child(&marker).child(&body);
                Rendered::Item { row, marker, body, label: Rc::default() }
            }
            _ => return None,
        };
        rendered.widget().shrink(0.0);
        Some(rendered)
    }

    /// Puts a new block's widget last in its parent's.
    fn attach(&self, parent: Option<u32>, rendered: &Rendered) {
        match parent {
            None => self.0.element.insert(rendered.widget().element(), None),
            Some(parent) => {
                let container = self.0.blocks.borrow()[parent as usize].rendered.as_ref().and_then(Rendered::container);
                if let Some(container) = container {
                    container.add(&rendered.widget());
                }
            }
        }
    }

    /// Puts `new` in place of `old` in the parent's widget.
    fn replace(&self, parent: Option<u32>, old: Option<&Rendered>, new: Option<&Rendered>) {
        let container = match parent {
            None => None,
            Some(parent) => self.0.blocks.borrow()[parent as usize].rendered.as_ref().and_then(Rendered::container),
        };
        let element = container.as_ref().map_or(&self.0.element, |view| view.element());
        let position = old.and_then(|old| {
            let id = old.widget().id();
            element.child_behaviors().iter().position(|child| child.element().id() == id)
        });
        if let Some(old) = old {
            old.widget().detach();
        }
        if let Some(new) = new {
            element.insert(new.widget().element(), position);
        }
    }

    /// Writes a paragraph or heading the widget writes itself: the parser's output through the inline hook, with its
    /// click targets. An unchanged output is not written again unless `force`, so the hook runs once per change.
    fn write_prose(&self, app: &App, doc: &MarkdownDoc, index: usize, text: &Text, force: bool) {
        let block = self.0.blocks.borrow()[index].block.index;
        let Some(leaf) = app.report(doc.read_leaf(block)) else { return };
        // A hook's output depends on the inline source too.
        let source = self.0.options.borrow().inline_hook.as_ref().map(|_| doc.read_source(block).unwrap_or_default());
        let written = (leaf, source);
        if !force && self.0.blocks.borrow()[index].written.as_ref() == Some(&written) {
            return;
        }
        let conceal = self.0.options.borrow().conceal;
        let spans = self.hook(doc, block, leaf_spans(&written.0, conceal), false, written.1.as_deref());
        let (mut ranges, mut end) = (Vec::new(), 0);
        let content: Vec<Span<'static>> = spans
            .into_iter()
            .map(|InlineSpan { span, target, .. }| {
                let start = end;
                end += span.content.len();
                ranges.extend(target.map(|target| (start..end, target)));
                span
            })
            .collect();
        let mut hasher = DefaultHasher::new();
        for span in &content {
            (&span.content, span.style, &span.link).hash(&mut hasher);
        }
        let hash = Some(hasher.finish());
        if self.0.blocks.borrow()[index].content != hash {
            text.set_text(content);
        }
        {
            let mut blocks = self.0.blocks.borrow_mut();
            blocks[index].written = Some(written);
            blocks[index].content = hash;
            blocks[index].host_wrote = true;
        }
        self.set_targets(app, index, ranges);
    }

    /// The click targets of block `index`'s text from the next frame on; until a frame paints them, clicks keep
    /// reaching the ones on screen.
    fn set_targets(&self, app: &App, index: usize, ranges: Vec<(Range<usize>, String)>) {
        let since = app.painted_frames();
        let mut blocks = self.0.blocks.borrow_mut();
        let shown = &mut blocks[index];
        let painted =
            shown.targets.take().map_or_else(Vec::new, |old| if old.since < since { old.ranges } else { old.painted });
        if !ranges.is_empty() || !painted.is_empty() {
            shown.targets = Some(Targets { ranges, since, painted });
            app.request_redraw();
        }
    }

    /// `spans` of leaf `block` as the inline hook rewrites them, if there is one; `source` is its inline source, if
    /// read already.
    fn hook(
        &self,
        doc: &MarkdownDoc,
        block: u32,
        spans: Vec<InlineSpan>,
        table_cell: bool,
        source: Option<&str>,
    ) -> Vec<InlineSpan> {
        let options = Rc::clone(&self.0.options.borrow());
        let Some(hook) = &options.inline_hook else { return spans };
        let source = source.map_or_else(|| doc.read_source(block).unwrap_or_default(), str::to_owned);
        let syntax = Arc::clone(&self.0.syntax.borrow());
        hook(spans, &InlineContext { source: &source, conceal: options.conceal, syntax: &syntax, table_cell })
    }

    /// A code block: from a registered renderer, or highlighted as the filetype its fence names. `previous` is the
    /// block's widget shown so far.
    fn code_block(
        &self,
        app: &App,
        doc: &MarkdownDoc,
        block: &MarkdownBlock,
        previous: Option<&Rendered>,
    ) -> Option<Rendered> {
        let code = String::from_utf8_lossy(&app.report(doc.read_leaf(block.index))?.bytes).into_owned();
        // Read without the borrow guard: a change holds it, and nothing changes the source here.
        let source = app.report(doc.source())?;
        let info = source[block.info.start as usize..block.info.end as usize].to_owned();
        let info = (!info.is_empty()).then_some(info);
        let options = Rc::clone(&self.0.options.borrow());
        // Display math is code of the language `math` for renderers, as Core's `lang: "math"`; without one it is plain.
        let name = if block.has(sys::OT_MD_BLOCK_MATH) { Some("math") } else { info.as_deref() };
        let custom = name.and_then(|info| {
            let language = filetype_for_info_string(info)?;
            let (_, render) = options.code_blocks.iter().find(|(key, _)| *key == language)?;
            let previous = match previous {
                Some(Rendered::Custom(widget)) => Some(widget),
                _ => None,
            };
            let closed = block.has(sys::OT_MD_BLOCK_CLOSED);
            let (conceal, streaming) = (options.conceal, options.streaming);
            if !streaming {
                self.0.rendered_code.borrow_mut().push(block.index);
            }
            render(&CodeBlock { app, language: &language, info, code: &code, closed, conceal, streaming, previous })
        });
        if let Some(widget) = custom {
            return Some(Rendered::Custom(widget));
        }
        let language = info.as_deref().and_then(|info| info.split_whitespace().next());
        if let Some(Rendered::Code(container, view)) = previous {
            view.filetype(language).set_code(code.as_str());
            return Some(Rendered::Code(container.clone(), view.clone()));
        }
        let base = self.base(block.parent);
        let colors = *self.0.colors.borrow();
        // It shows all its lines, wrapped as Core's, so it has nothing to scroll and takes no focus: Tab passes over it.
        let view = Code::themed(app, Arc::clone(&self.0.syntax.borrow()), self.0.style.as_ref())
            .fg(base.fg.unwrap_or(colors.text))
            .filetype(language)
            .set_code(code)
            .wrap(WrapMode::Word)
            .focusable(false);
        Some(Rendered::Code(View::new(app).bg(colors.code_bg).child(&view), view))
    }

    fn table(&self, app: &App, base: Style) -> TextTable {
        let options = self.0.options.borrow().table;
        let styles = self.0.styles.get();
        let columns = options.style == MarkdownTableStyle::Columns;
        let borders = options.borders.unwrap_or(!columns);
        let widget = TextTable::new(app).fg(base.fg.unwrap_or(self.0.colors.borrow().text));
        if let Some(style) = options.border_style {
            widget.border(style);
        }
        let width_mode = if columns { ColumnWidthMode::Content } else { ColumnWidthMode::Full };
        widget
            .grid_lines(borders)
            .outer_border(options.outer_border.unwrap_or(borders))
            .show_borders(borders)
            .border_color(options.border_color.unwrap_or(styles.rule))
            .column_width_mode(options.width_mode.unwrap_or(width_mode))
            .column_fitter(options.column_fitter.unwrap_or_default())
            .wrap(options.wrap.unwrap_or(WrapMode::Word))
            .cell_padding_x(options.cell_padding_x.unwrap_or(0))
            .cell_padding_y(options.cell_padding_y.unwrap_or(0))
            .column_gap(if columns && !borders { 2 } else { 0 })
            .selectable(options.selectable.unwrap_or(true));
        widget
    }

    /// Fills a table from its rows and cells: a header row in the heading color, then the body, each row as wide as
    /// the header. Like Core's, cells do not follow column alignment.
    fn fill_table(&self, app: &App, doc: &MarkdownDoc, table: u32) {
        let (widget, columns, rows) = {
            let blocks = self.0.blocks.borrow();
            let Some(Some(Rendered::Table(widget))) = blocks.get(table as usize).map(|shown| shown.rendered.clone())
            else {
                return;
            };
            let columns = blocks[table as usize].block.number as usize;
            let mut rows: Vec<(bool, Vec<u32>)> = Vec::new();
            for shown in &blocks[table as usize + 1..] {
                match (shown.block.kind, shown.block.parent) {
                    (sys::OT_MD_TABLE_ROW, Some(parent)) if parent == table => {
                        rows.push((shown.block.has(sys::OT_MD_BLOCK_HEADER), Vec::new()));
                    }
                    (sys::OT_MD_TABLE_CELL, Some(_)) => {
                        rows.last_mut().expect("a cell follows its row").1.push(shown.block.index)
                    }
                    _ => break,
                }
            }
            (widget, columns, rows)
        };
        let header = self.0.styles.get().table_header;
        let conceal = self.0.options.borrow().conceal;
        let content: Vec<Vec<Content>> = rows
            .into_iter()
            .map(|(is_header, cells)| {
                let mut row: Vec<Content> = cells
                    .into_iter()
                    .map(|cell| {
                        let leaf = app.report(doc.read_leaf(cell)).unwrap_or_default();
                        let spans = self.hook(doc, cell, leaf_spans(&leaf, conceal), true, None);
                        Content(
                            spans
                                .into_iter()
                                .map(|span| {
                                    let span = span.span;
                                    if is_header { Span { style: header.patch(span.style), ..span } } else { span }
                                })
                                .collect(),
                        )
                    })
                    .collect();
                row.resize_with(row.len().max(columns), || Content(Vec::new()));
                row
            })
            .collect();
        widget.set_content(content);
    }

    /// A list's gap and its items' markers: numbers align on their right, and the list is loose when a blank line
    /// separates items (tight once it closes unless the engine says otherwise).
    fn update_list(&self, app: &App, doc: &MarkdownDoc, list: u32) {
        let blocks = self.0.blocks.borrow();
        let Some(shown) = blocks.get(list as usize) else { return };
        let Some(Rendered::Other(view)) = &shown.rendered else { return };
        let block = &shown.block;
        let end = (list as usize + 1..blocks.len())
            .find(|&i| blocks[i].block.parent.is_none_or(|parent| parent < list))
            .unwrap_or(blocks.len());
        let items: Vec<&Shown> =
            blocks[list as usize + 1..end].iter().filter(|item| item.block.parent == Some(list)).collect();
        // The engine says once the list closes; until then, as CommonMark decides it for the lines so far: loose when
        // a blank line separates two items or two blocks of an item.
        let tight = if block.has(sys::OT_MD_BLOCK_OPEN) {
            // Read only for an item with two blocks, so a streamed list does not copy its source per append.
            let source = std::cell::OnceCell::new();
            let separated = |a: &Shown, b: &Shown| {
                source
                    .get_or_init(|| app.report(doc.source()).unwrap_or_default())
                    .get(a.block.source.end as usize..b.block.source.start as usize)
                    .is_some_and(|gap| gap.matches('\n').count() > 1)
            };
            // One pass in preorder: an item's blocks come together, each after the one before it.
            let mut last: Option<&Shown> = None;
            !items.iter().any(|item| item.block.has(sys::OT_MD_BLOCK_BLANK_AFTER))
                && !blocks[list as usize + 1..end].iter().any(|child| {
                    let Some(parent) = child.block.parent else { return false };
                    if parent == list {
                        last = None;
                        return false;
                    }
                    if blocks[parent as usize].block.parent != Some(list) {
                        return false;
                    }
                    last.replace(child).is_some_and(|previous| separated(previous, child))
                })
        } else {
            block.has(sys::OT_MD_BLOCK_TIGHT)
        };
        let gap = if tight { 0 } else { 1 };
        view.gap(gap);
        let ordered = block.has(sys::OT_MD_BLOCK_ORDERED);
        let last = u64::from(block.number) + (items.len() as u64).saturating_sub(1);
        let digits = |number: u64| number.checked_ilog10().unwrap_or(0) as usize + 1;
        let width = if ordered { digits(last) + 1 } else { 1 };
        let marker = self.base(Some(list)).patch(self.0.styles.get().list);
        let conceal = self.0.options.borrow().conceal;
        let mut text = String::new();
        for (n, item) in items.iter().enumerate() {
            let Some(Rendered::Item { marker: widget, body, label, .. }) = &item.rendered else { continue };
            let task = match (item.block.has(sys::OT_MD_BLOCK_TASK), item.block.has(sys::OT_MD_BLOCK_CHECKED), conceal)
            {
                (false, ..) => "",
                (true, true, true) => " ☑",
                (true, false, true) => " ☐",
                (true, true, false) => " [x]",
                (true, false, false) => " [ ]",
            };
            text.clear();
            if ordered {
                let number = u64::from(block.number) + n as u64;
                text.extend(std::iter::repeat_n(' ', width - digits(number) - 1));
                let _ = write!(text, "{number}.{task} ");
            } else {
                let _ = write!(text, "-{task} ");
            }
            if *label.borrow() != text {
                widget.set_text(vec![Span::styled(text.clone(), marker)]);
                label.replace(text.clone());
            }
            body.gap(gap);
        }
    }

    /// Runs the code-block renderers again with their widgets, for a change they read: the end of streaming.
    fn rerun_renderers(&self) {
        let (Some(app), Some(doc)) = (self.app(), &self.0.doc) else { return };
        let count = self.0.blocks.borrow().len();
        for index in 0..count {
            let (block, rendered) = {
                let blocks = self.0.blocks.borrow();
                (blocks[index].block.clone(), blocks[index].rendered.clone())
            };
            // A renderer that chose the default widget while streaming may choose its own now; one the finish
            // already asked is not asked again.
            if block.kind != sys::OT_MD_CODE
                || self.0.options.borrow().code_blocks.is_empty()
                || self.0.rendered_code.borrow().contains(&block.index)
            {
                continue;
            }
            let new = self.code_block(&app, doc, &block, rendered.as_ref());
            if new.as_ref().map(Rendered::widget) != rendered.as_ref().map(Rendered::widget) {
                self.replace(block.parent, rendered.as_ref(), new.as_ref());
            }
            self.0.blocks.borrow_mut()[index].rendered = new;
        }
    }

    /// New styles from `colors`, `syntax` and `scopes`: the doc's style takes them, so the text it writes repaints
    /// as is; the widgets around it are built again.
    fn restyle(&self) {
        let options = Rc::clone(&self.0.options.borrow());
        let styles = MarkdownStyles::new(&self.0.colors.borrow(), options.scopes.then_some(&**self.0.syntax.borrow()));
        self.0.styles.set(styles);
        if let (Some(app), Some(style)) = (self.app(), &self.0.style) {
            app.report(styles.register(style));
        }
        self.rebuild_all(true);
    }

    fn rebuild_all(&self, keep_code: bool) {
        let tops: Vec<u32> =
            self.0.blocks.borrow().iter().filter(|shown| shown.block.parent.is_none()).map(|s| s.block.index).collect();
        for top in tops {
            self.rebuild_subtree(top, keep_code);
        }
    }

    /// Builds top-level block `top` and its descendants again, keeping the text widgets of paragraphs and headings
    /// (the doc writes them, or the widget writes them again here), and with `keep_code`, for new styles, the code
    /// widgets, which restyle their highlight as it is.
    fn rebuild_subtree(&self, top: u32, keep_code: bool) {
        let (Some(app), Some(doc)) = (self.app(), &self.0.doc) else { return };
        let end = {
            let blocks = self.0.blocks.borrow();
            (top as usize + 1..blocks.len()).find(|&i| blocks[i].block.parent.is_none()).unwrap_or(blocks.len())
        };
        let old_top = self.0.blocks.borrow()[top as usize].rendered.clone();
        let position = old_top.as_ref().and_then(|old| {
            let id = old.widget().id();
            self.0.element.child_behaviors().iter().position(|child| child.element().id() == id)
        });
        if let Some(old) = &old_top {
            old.widget().detach();
        }
        let mut refresh = Refresh::default();
        for index in top as usize..end {
            let (block, old) = {
                let blocks = self.0.blocks.borrow();
                (blocks[index].block.clone(), blocks[index].rendered.clone())
            };
            let new = match (&block.kind, old) {
                (&PARAGRAPH | &HEADING, Some(Rendered::Text(text))) => {
                    let base = self.base(block.parent);
                    text.detach();
                    text.fg(base.fg.unwrap_or(self.0.colors.borrow().text)).attributes(base.attributes);
                    Some(Rendered::Text(text))
                }
                // A registered renderer chooses again; a built-in view it declines restyles as it is.
                (&sys::OT_MD_CODE, Some(old @ Rendered::Code(..))) if keep_code => {
                    let new = self.code_block(&app, doc, &block, Some(&old));
                    if let Some(Rendered::Code(container, code)) = &new {
                        let colors = *self.0.colors.borrow();
                        container.detach();
                        container.bg(colors.code_bg);
                        let fg = self.base(block.parent).fg.unwrap_or(colors.text);
                        code.0.restyle(Arc::clone(&self.0.syntax.borrow()), fg);
                    }
                    new
                }
                _ => self.build_block(&app, doc, &block),
            };
            self.0.blocks.borrow_mut()[index].rendered = new.clone();
            if index != top as usize
                && let Some(new) = &new
            {
                self.attach(block.parent, new);
            }
        }
        let new_top = self.0.blocks.borrow()[top as usize].rendered.clone();
        if let Some(new_top) = &new_top {
            self.0.element.insert(new_top.widget().element(), position);
        }
        for index in top as usize..end {
            self.after_rebuild(&app, doc, index, &mut refresh);
        }
        self.finish_refresh(&app, doc, refresh);
    }

    fn after_rebuild(&self, app: &App, doc: &MarkdownDoc, index: usize, refresh: &mut Refresh) {
        let (block, rendered) = {
            let blocks = self.0.blocks.borrow();
            (blocks[index].block.clone(), blocks[index].rendered.clone())
        };
        if let (PARAGRAPH | HEADING, Some(Rendered::Text(text))) = (block.kind, &rendered) {
            if self.host_writes() {
                self.write_prose(app, doc, index, text, true);
                return;
            }
            // Attached again, the text shows what the widget last set: native code writes it whole when bound again.
            self.0.blocks.borrow_mut()[index].host_wrote = true;
        }
        self.after_change(app, doc, index, refresh);
    }
}

/// The blocks a call removed, kept until it ends: a text or code block that takes a removed one's place, while
/// every block before it in the removed range did, keeps the removed one's widget.
#[derive(Default)]
struct Removed {
    from: u32,
    blocks: Vec<Shown>,
    reusing: bool,
}

impl Removed {
    fn reuse(&mut self, block: &MarkdownBlock) -> Option<Shown> {
        // Containers are never taken back, and taking back stops at the first that is not: a block taken back has a
        // parent that stays.
        let at = block.index.checked_sub(self.from).map(|at| at as usize);
        let reusable = self.reusing
            && at.and_then(|at| self.blocks.get(at)).is_some_and(|old| {
                old.block.kind == block.kind
                    && old.block.parent == block.parent
                    && matches!(old.rendered, Some(Rendered::Text(_) | Rendered::Code(..) | Rendered::Custom(_)))
            });
        self.reusing = reusable;
        if !reusable {
            return None;
        }
        let old = &mut self.blocks[(block.index - self.from) as usize];
        Some(Shown {
            block: old.block.clone(),
            rendered: old.rendered.take(),
            written: old.written.take(),
            content: old.content.take(),
            targets: old.targets.take(),
            host_wrote: false,
        })
    }
}

/// The tables and lists a call changed, refreshed once each after its blocks.
#[derive(Default)]
struct Refresh {
    tables: std::collections::BTreeSet<u32>,
    lists: std::collections::BTreeSet<u32>,
}

impl Refresh {
    fn table(&mut self, table: u32) {
        self.tables.insert(table);
    }

    fn list(&mut self, list: u32) {
        self.lists.insert(list);
    }

    /// A child of `parent` changed: a row's or a cell's table, an item's list.
    fn parent_changed(&mut self, blocks: &[Shown], parent: u32) {
        let Some(shown) = blocks.get(parent as usize) else { return };
        match shown.block.kind {
            sys::OT_MD_TABLE => self.table(parent),
            sys::OT_MD_TABLE_ROW => self.table(shown.block.parent.expect("a row has its table")),
            sys::OT_MD_LIST => self.list(parent),
            sys::OT_MD_ITEM => self.list(shown.block.parent.expect("an item has its list")),
            _ => {}
        }
    }
}

/// Two calls' results as one: the earlier removal, the later counts.
fn merge(first: MarkdownResult, second: MarkdownResult) -> MarkdownResult {
    let removed_from = match (first.removed_from, second.removed_from) {
        (Some(a), Some(b)) => Some(a.min(b)),
        (a, b) => a.or(b),
    };
    MarkdownResult { removed_from, ..second }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::testing::TestApp;

    /// The Rust widget's block widgets follow the engine's blocks: every listed block of a corpus row, streamed in
    /// its chunks, has the widget its kind takes.
    #[test]
    fn widgets_follow_the_engines_blocks_across_kind_changes_and_removals() {
        let app = TestApp::new(40, 12);
        let markdown = Markdown::new(&app).streaming(true);
        app.root().add(&markdown);
        for chunk in ["para", "\n===\n\n| a |\n| - |\n| 1 |", "\n\n> q\n\n- x\n- y\n\n```rs\nfn x() {}\n```\n"] {
            markdown.append(chunk);
        }
        markdown.set_markdown("para\n===\n\nother");
        let blocks = markdown.0.blocks.borrow();
        let kinds: Vec<u32> = blocks.iter().map(|shown| shown.block.kind).collect();
        assert_eq!(kinds, [HEADING, PARAGRAPH]);
        assert!(blocks.iter().all(|shown| matches!(shown.rendered, Some(Rendered::Text(_)))));
        drop(blocks);
        assert_eq!(app.text().trim_end(), "para\n===\n\nother");
    }

    // C4 invariant 3 (P11): new colors and a new syntax theme keep every code block's widget and restyle its
    // highlight, a running one included: no highlight starts and no layer is written. The settled frame equals a
    // document built with them, with the new code background, a quoted block's text color and the streamed tail.
    #[cfg(feature = "tree-sitter")]
    #[test]
    fn a_theme_switch_keeps_code_blocks_and_highlights_nothing() {
        use crate::widget::code::tests::settle;
        let source = "```rust\nlet a = \"s\";\n```\n\n> ```rust\n> fn q() {}\n> ```\n\n```rust\nlet b = 1;\n";
        let theme = SyntaxTheme::new()
            .style("keyword", Style::new().fg(Color::RED).bold())
            .style("string", Style::new().fg(Color::GREEN))
            .style("default", Style::new().italic());
        let colors = |app: &TestApp| MarkdownColors {
            code_bg: Color::BLUE,
            quote: Color::YELLOW,
            ..MarkdownColors::from_theme(&app.theme())
        };
        let codes = |markdown: &Markdown| -> Vec<Code> {
            let blocks = markdown.0.blocks.borrow();
            (blocks.iter().filter_map(|shown| match &shown.rendered {
                Some(Rendered::Code(_, code)) => Some(code.clone()),
                _ => None,
            }))
            .collect()
        };
        let (app, fresh) = (TestApp::new(30, 12), TestApp::new(30, 12));
        let markdown = Markdown::new(&app).streaming(true);
        app.root().add(&markdown);
        markdown.set_markdown(source);
        settle(&app, &codes(&markdown));
        markdown.append("let c = 2;\n");
        app.render();
        let before: Vec<_> = codes(&markdown).iter().map(|code| (code.element().id(), code.0.work.get())).collect();
        assert_eq!(before.len(), 3);
        markdown.syntax_theme(theme.clone()).colors(colors(&app));
        let after: Vec<_> = codes(&markdown).iter().map(|code| (code.element().id(), code.0.work.get())).collect();
        assert_eq!(after, before, "the switch built or highlighted a code block");
        let got = settle(&app, &codes(&markdown));
        let parses: Vec<_> = codes(&markdown).iter().map(|code| code.0.work.get().0).collect();
        assert_eq!(parses, before.iter().map(|(_, work)| work.0).collect::<Vec<_>>());
        let twin = Markdown::new(&fresh).syntax_theme(theme).colors(colors(&fresh)).streaming(true);
        fresh.root().add(&twin);
        twin.set_markdown(format!("{source}let c = 2;\n"));
        let want = settle(&fresh, &codes(&twin));
        let differ = want.cells.iter().zip(&got.cells).position(|(want, got)| want != got);
        assert!(differ.is_none(), "cell {differ:?}");
    }

    // A restyle keeps a code block's widget only as a fresh build would choose it: a changed info string changes the
    // filetype, and a registered renderer that declined before is asked again (bigboi-1, bigboi-2).
    #[cfg(feature = "tree-sitter")]
    #[test]
    fn a_restyled_code_block_follows_its_info_string_and_renderer() {
        use crate::widget::Text;
        use crate::widget::code::tests::settle;
        let theme = SyntaxTheme::new().style("keyword", Style::new().fg(Color::RED));
        let custom = Rc::new(Cell::new(false));
        let build = |app: &TestApp, source: &str| {
            let custom = Rc::clone(&custom);
            let markdown = Markdown::new(app).code_block_renderer("mermaid", move |block| {
                custom.get().then(|| Text::new(block.app, "diagram").as_any())
            });
            app.root().add(&markdown);
            markdown.set_markdown(source);
            markdown
        };
        let source = "```unknown\r\nlet a = 42;\r\n```\r\n\r\n```mermaid\nflow\n```\n";
        let (app, fresh) = (TestApp::new(30, 8), TestApp::new(30, 8));
        let markdown = build(&app, &source.replacen("unknown", "rust", 1));
        settle(&app, &[]);
        markdown.set_markdown(source);
        custom.set(true);
        markdown.syntax_theme(theme.clone());
        build(&fresh, source).syntax_theme(theme);
        let (want, got) = (fresh.render(), app.render());
        let differ = want.cells.iter().zip(&got.cells).position(|(want, got)| want != got);
        assert!(differ.is_none(), "cell {differ:?}: {:?}", app.text());
    }
}
