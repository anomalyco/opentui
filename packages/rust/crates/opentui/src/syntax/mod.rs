//! Syntax highlighting for [`Code`](crate::widget::Code), [`Textarea`](crate::widget::Textarea),
//! [`Diff`](crate::widget::Diff), and [`Markdown`](crate::widget::Markdown) code blocks.
//!
//! With the `tree-sitter` feature, tree-sitter parses the text and its highlight queries name each piece: `keyword`,
//! `string`, `function.method`, and so on. A [`SyntaxTheme`] maps those names to styles. The feature bundles Core's
//! grammars (JavaScript, TypeScript and TSX, Markdown, Zig) and Rust, compiled the first time each is shown;
//! `register` adds others, such as any `tree-sitter-*` grammar crate, and `register_lazy` defers their compiling the
//! same way:
//!
//! ```ignore
//! use opentui::syntax::{Grammar, register};
//! register("python", Grammar::new(tree_sitter_python::LANGUAGE, tree_sitter_python::HIGHLIGHTS_QUERY))?;
//! ```
//!
//! `prewarm` compiles a grammar before it is first shown, from any thread, so the frame that shows it does not compile it.
//!
//! Without the feature, widgets show plain text and the filetypes they are given have no effect.
//!
//! Capture names come from each grammar's own queries, so they follow tree-sitter's conventions. Core uses
//! nvim-treesitter's queries instead, which name some things differently: its Markdown headings are
//! `markup.heading`, where the Markdown grammar's own query says `text.title`. [`SyntaxTheme::from_theme`] styles
//! both.

mod filetype;
#[cfg(feature = "tree-sitter")]
mod highlight;

pub use filetype::{filetype_for_extension, filetype_for_info_string, filetype_for_path};
#[cfg(feature = "tree-sitter")]
pub use highlight::{
    Capture, CompiledGrammar, Grammar, GrammarError, filetypes, has_grammar, highlight, highlights, prewarm, register,
    register_alias, register_lazy, spans, tree_sitter,
};

use crate::error::Result;
use crate::native::{Context, LayerRun, SyntaxStyle};
use crate::style::{Color, Style};
use crate::theme::{Theme, ThemeMode};
use std::collections::{BTreeMap, HashMap};
use std::ops::Range;

/// Styles for capture names, kept in Rust. Core's TypeScript calls this a `SyntaxStyle`.
///
/// A name without a style of its own takes the style of its longest dotted prefix that has one, so
/// `function.method.call` falls back to `function.method`, then to `function`. Core falls back to the first part
/// only. The `default` style colors text no capture covers.
///
/// Widgets look styles up in Rust. For highlights you add to a native buffer yourself, [`Self::to_syntax_style`]
/// copies the styles into a native [`SyntaxStyle`] table.
///
/// ```
/// # use opentui::prelude::*;
/// # use opentui::syntax::SyntaxTheme;
/// let theme = SyntaxTheme::new()
///     .style("keyword", Style::new().fg(Color::hex(0xc792ea)).bold())
///     .style("comment", Style::new().fg(Color::hex(0x7d8a99)).italic());
/// assert_eq!(theme.get("keyword.return"), theme.get("keyword"));
/// assert_eq!(theme.get("string"), None);
/// ```
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct SyntaxTheme {
    styles: BTreeMap<String, Style>,
    first_part: bool,
}

impl SyntaxTheme {
    /// A theme with no styles: everything shows in the widget's text color.
    pub fn new() -> Self {
        Self::default()
    }

    /// Sets the style for a capture name.
    pub fn style(mut self, name: impl Into<String>, style: Style) -> Self {
        self.set(name, style);
        self
    }

    pub fn set(&mut self, name: impl Into<String>, style: Style) {
        self.styles.insert(name.into(), style);
    }

    pub fn remove(&mut self, name: &str) -> Option<Style> {
        self.styles.remove(name)
    }

    /// Falls back from a name without a style to its first dotted part only, as Core's `SyntaxStyle.getStyle`:
    /// `markup.link.bracket.close` takes `markup`'s style, not `markup.link`'s. For Core's queries, with
    /// `Grammar::core_captures`.
    pub fn first_part_fallback(mut self) -> Self {
        self.first_part = true;
        self
    }

    /// The style for a capture name, or for its longest dotted prefix with one ([`Self::first_part_fallback`]: its
    /// first part).
    pub fn get(&self, name: &str) -> Option<Style> {
        if self.first_part {
            let first = name.split('.').next().unwrap_or(name);
            return self.styles.get(name).or_else(|| self.styles.get(first)).copied();
        }
        let mut name = name;
        loop {
            if let Some(style) = self.styles.get(name) {
                return Some(*style);
            }
            name = &name[..name.rfind('.')?];
        }
    }

    /// The names with a style of their own, in order.
    pub fn names(&self) -> impl Iterator<Item = &str> {
        self.styles.keys().map(String::as_str)
    }

    /// The styles of several names applied in order, later ones on top, as Core's `mergeStyles`.
    pub fn merge<'a>(&self, names: impl IntoIterator<Item = &'a str>) -> Style {
        names.into_iter().filter_map(|name| self.get(name)).fold(Style::new(), Style::patch)
    }

    /// A native style table with each name's style registered under the name, for highlights added to a native
    /// buffer directly: [`SyntaxStyle::resolve`] gives a name's id. Only names with a style of their own are
    /// registered, so look a capture up by its longest registered dotted prefix, as [`Self::get`] does.
    pub fn to_syntax_style(&self, context: &Context) -> Result<SyntaxStyle> {
        let table = SyntaxStyle::new(context)?;
        for (name, style) in &self.styles {
            table.register(name, *style)?;
        }
        Ok(table)
    }

    /// A palette for the app's theme: light colors on dark backgrounds and dark ones on light backgrounds. It styles
    /// the names the bundled grammars use, and Core's names for the same things.
    pub fn from_theme(theme: &Theme) -> Self {
        let light = ThemeMode::from_background(theme.background) == ThemeMode::Light && theme.background.a > 0;
        let palette = if light { Palette::LIGHT } else { Palette::DARK };
        let fg = |color: Color| Style::new().fg(color);
        let comment = fg(theme.muted).italic();
        let mut styles = Self::new();
        for (names, style) in [
            (
                &["keyword", "keyword.operator", "conditional", "repeat", "include", "exception"][..],
                fg(palette.keyword),
            ),
            (&["string", "character"], fg(palette.string)),
            (&["string.escape", "escape", "string.special", "string.regexp", "character.special"], fg(palette.escape)),
            (&["comment", "comment.documentation"], comment),
            (&["number", "float", "boolean", "constant", "constant.builtin", "label"], fg(palette.number)),
            (&["type", "type.builtin", "constructor", "module", "namespace", "attribute"], fg(palette.kind)),
            (&["function", "function.method", "function.call", "method"], fg(palette.function)),
            (&["function.macro", "function.builtin", "operator", "punctuation.special"], fg(palette.operator)),
            (&["property", "variable.member", "field", "tag", "variable.builtin"], fg(palette.property)),
            (&["markup.heading", "text.title"], fg(palette.function).bold()),
            (&["markup.strong", "markup.bold", "text.strong"], Style::new().bold()),
            (&["markup.italic", "text.emphasis"], Style::new().italic()),
            (&["markup.strikethrough"], Style::new().strikethrough()),
            (&["markup.raw", "text.literal"], fg(palette.string)),
            (&["markup.link", "markup.link.label", "text.reference"], fg(palette.function)),
            (&["markup.link.url", "text.uri"], fg(palette.escape).underline()),
            (&["markup.list"], fg(palette.number)),
            (&["markup.quote"], comment),
        ] {
            for name in names {
                styles.set(*name, style);
            }
        }
        styles
    }
}

impl<K: Into<String>> FromIterator<(K, Style)> for SyntaxTheme {
    fn from_iter<I: IntoIterator<Item = (K, Style)>>(iter: I) -> Self {
        Self { styles: iter.into_iter().map(|(name, style)| (name.into(), style)).collect(), first_part: false }
    }
}

/// Foreground colors for [`SyntaxTheme::from_theme`].
struct Palette {
    keyword: Color,
    string: Color,
    escape: Color,
    number: Color,
    kind: Color,
    function: Color,
    operator: Color,
    property: Color,
}

impl Palette {
    /// Material-style colors, as the old built-in highlighter used.
    const DARK: Self = Self {
        keyword: Color::hex(0xc792ea),
        string: Color::hex(0xc3e88d),
        escape: Color::hex(0x89ddff),
        number: Color::hex(0xf78c6c),
        kind: Color::hex(0xffcb6b),
        function: Color::hex(0x82aaff),
        operator: Color::hex(0x89ddff),
        property: Color::hex(0xf07178),
    };

    /// GitHub-style colors for light backgrounds.
    const LIGHT: Self = Self {
        keyword: Color::hex(0xcf222e),
        string: Color::hex(0x0a3069),
        escape: Color::hex(0x0550ae),
        number: Color::hex(0x0550ae),
        kind: Color::hex(0x953800),
        function: Color::hex(0x8250df),
        operator: Color::hex(0x0550ae),
        property: Color::hex(0x116329),
    };
}

/// Group sets of capture-name lists, by list, as a widget's syntax layer names its pieces: each name is registered as
/// `opentui.<name>` in the widget's style table, with the table's palette.
#[derive(Default)]
pub(crate) struct CaptureSets(HashMap<Vec<&'static str>, u32>);

impl CaptureSets {
    /// The lists seen.
    pub(crate) fn lists(&self) -> Vec<Vec<&'static str>> {
        self.0.keys().cloned().collect()
    }

    /// The layer runs of [`highlight_names`]' pieces, each edge mapped to the buffer's bytes by `edge`, and empty runs
    /// left out. Past the Context's group-set bound a list has no set, and its pieces paint plain rather than ending
    /// the app.
    pub(crate) fn runs(
        &mut self,
        table: &SyntaxStyle,
        context: &Context,
        (lists, pieces): NamedRanges,
        edge: impl Fn(usize) -> usize,
    ) -> Result<Vec<LayerRun>> {
        let mut sets = Vec::with_capacity(lists.len());
        for names in lists {
            if let Some(&id) = self.0.get(&names) {
                sets.push(Some(id));
                continue;
            }
            let group = table.capture_group(&names)?;
            let id = context.group_set(&group.iter().map(String::as_str).collect::<Vec<_>>()).ok();
            if let Some(id) = id {
                self.0.insert(names, id);
            }
            sets.push(id);
        }
        Ok((pieces.into_iter())
            .filter_map(|(range, list)| {
                let (start_byte, end_byte) = (edge(range.start) as u32, edge(range.end) as u32);
                (start_byte < end_byte).then_some(LayerRun { start_byte, end_byte, group_set: sets[list]? })
            })
            .collect())
    }
}

/// The styled byte ranges of `source` as `filetype` with `theme`, covering it in order as `highlight` styles it,
/// or `None` without a grammar for it or without the `tree-sitter` feature. Widgets paint capture names instead;
/// tests compare them with these styles.
#[cfg(all(test, feature = "tree-sitter"))]
pub(crate) fn highlight_ranges(
    source: &str,
    filetype: &str,
    theme: &SyntaxTheme,
) -> Option<Vec<(Range<usize>, Style)>> {
    Some(styled_ranges(highlight_names(source, filetype)?, theme))
}

/// The pieces of named ranges with their lists' styles merged, neighbors of one style joined.
#[cfg(feature = "tree-sitter")]
fn styled_ranges((lists, named): NamedRanges, theme: &SyntaxTheme) -> Vec<(Range<usize>, Style)> {
    let styles: Vec<Style> = lists.into_iter().map(|names| theme.merge(names)).collect();
    let mut pieces: Vec<(Range<usize>, Style)> = Vec::new();
    for (range, list) in named {
        match pieces.last_mut() {
            Some((last, style)) if *style == styles[list] => last.end = range.end,
            _ => pieces.push((range, styles[list])),
        }
    }
    pieces
}

pub(crate) type NamedRanges = (Vec<Vec<&'static str>>, Vec<(Range<usize>, usize)>);

/// The lists of capture names whose styles [`highlight_ranges`] would merge with any theme, in order, and the byte
/// ranges of `source` as `filetype` with the index of their list; `None` as there.
pub(crate) fn highlight_names(source: &str, filetype: &str) -> Option<NamedRanges> {
    #[cfg(feature = "tree-sitter")]
    return Some(highlight::named_ranges(source, &highlights(source, filetype)?));
    #[cfg(not(feature = "tree-sitter"))]
    {
        let _ = (source, filetype);
        None
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn names_fall_back_to_their_longest_styled_prefix() {
        let bold = Style::new().bold();
        let red = Style::new().fg(Color::RED);
        let theme = SyntaxTheme::new().style("function", bold).style("function.method", red);
        assert_eq!(theme.get("function.method.call"), Some(red));
        assert_eq!(theme.get("function.builtin"), Some(bold));
        assert_eq!(theme.get("functions"), None);
        assert_eq!(theme.get(""), None);
        assert_eq!(theme.merge(["function", "function.method"]), red.bold());
        let collected: SyntaxTheme = [("function", bold)].into_iter().collect();
        assert_eq!(collected.names().collect::<Vec<_>>(), ["function"]);
        let core = theme.first_part_fallback();
        assert_eq!(core.get("function.method.call"), Some(bold));
        assert_eq!(core.get("function.method"), Some(red));
        assert_eq!(core.get("functions.x"), None);
    }

    #[test]
    fn the_default_palette_follows_the_app_theme() {
        let dark = SyntaxTheme::from_theme(&Theme::dark());
        let light = SyntaxTheme::from_theme(&Theme::light());
        assert_ne!(dark.get("keyword"), light.get("keyword"));
        assert_eq!(dark.get("markup.heading.1"), dark.get("text.title"));
        assert!(dark.get("comment").unwrap().attributes.contains(crate::style::Attributes::ITALIC));
        // A transparent background says nothing about the terminal's, so it keeps the dark palette.
        assert_eq!(SyntaxTheme::from_theme(&Theme::terminal()).get("keyword"), dark.get("keyword"));
    }
}
