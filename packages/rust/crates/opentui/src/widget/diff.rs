//! Unified and split diff views with line numbers, ported from Core's `DiffRenderable`.

use super::{Behavior, Code, Element, LineColor, LineNumbers, LineSign, Text, Widget, build, handle};
use crate::app::App;
use crate::layout::{FlexDirection, LayoutProperty, Length};
use crate::native::{NodeKind, WrapMode};
use crate::style::Color;
use crate::syntax::SyntaxTheme;
use crate::theme::{Theme, ThemeMode};
use std::cell::{Cell, RefCell};
use std::collections::{HashMap, HashSet};
use std::rc::Rc;

/// How a [`Diff`] lays out old and new lines.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Hash)]
pub enum DiffView {
    /// One column: removed lines, then added lines, between unchanged ones.
    #[default]
    Unified,
    /// The old file on the left and the new one on the right, with changed lines side by side.
    Split,
}

/// Colors of a [`Diff`]. Content backgrounds of `None` use the line's background.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct DiffColors {
    pub line_number: Color,
    pub line_number_bg: Color,
    pub added_bg: Color,
    pub removed_bg: Color,
    pub context_bg: Color,
    pub added_content_bg: Option<Color>,
    pub removed_content_bg: Option<Color>,
    pub context_content_bg: Option<Color>,
    pub added_sign: Color,
    pub removed_sign: Color,
    pub added_line_number_bg: Color,
    pub removed_line_number_bg: Color,
}

impl DiffColors {
    /// Core's colors on dark themes, and lighter backgrounds on light ones.
    pub fn from_theme(theme: &Theme) -> Self {
        let light = ThemeMode::from_background(theme.background) == ThemeMode::Light && theme.background.a > 0;
        let (added_bg, removed_bg) = if light {
            (Color::hex(0xdaf5dd), Color::hex(0xfbe1e1))
        } else {
            (Color::hex(0x1a4d1a), Color::hex(0x4d1a1a))
        };
        let (added_sign, removed_sign) = if light {
            (Color::hex(0x15803d), Color::hex(0xb91c1c))
        } else {
            (Color::hex(0x22c55e), Color::hex(0xef4444))
        };
        Self {
            line_number: if light { theme.muted } else { Color::hex(0x888888) },
            line_number_bg: Color::TRANSPARENT,
            added_bg,
            removed_bg,
            context_bg: Color::TRANSPARENT,
            added_content_bg: None,
            removed_content_bg: None,
            context_content_bg: None,
            added_sign,
            removed_sign,
            added_line_number_bg: Color::TRANSPARENT,
            removed_line_number_bg: Color::TRANSPARENT,
        }
    }
}

/// The line number gutter of a [`Diff`], as Core's `DiffGutterOptions`.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct DiffGutter {
    /// Cells before the line numbers, in each row's gutter color; 1 by default.
    pub padding_left: u32,
    /// Room for at least this many digits, and for the sign column even when no line has a sign. Give several
    /// diffs the same value to line up their code.
    pub min_digits: Option<u32>,
}

impl Default for DiffGutter {
    fn default() -> Self {
        Self { padding_left: 1, min_digits: None }
    }
}

/// The width of the ` +` and ` -` signs.
const SIGN_WIDTH: u32 = 2;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum Kind {
    Context,
    Added,
    Removed,
    /// Padding in a split view, opposite a change with no counterpart.
    Empty,
}

#[derive(Clone, Debug, PartialEq, Eq)]
struct Hunk {
    old_start: u64,
    new_start: u64,
    /// Lines with their first character: ' ', '+', or '-'.
    lines: Vec<(char, String)>,
}

fn parse_range(text: &str) -> Option<(u64, u64)> {
    let (start, count) = text.split_once(',').unwrap_or((text, "1"));
    Some((start.parse().ok()?, count.parse().ok()?))
}

/// Parses the first file of a unified diff. Lines before its first hunk are headers. Lines after a hunk's counts, up to
/// the next hunk or file, are ignored, as `git apply` and `patch` ignore them.
fn parse(text: &str) -> Result<Vec<Hunk>, String> {
    let mut hunks: Vec<Hunk> = Vec::new();
    let mut remaining = (0u64, 0u64);
    for (index, line) in text.lines().enumerate() {
        let number = index + 1;
        if remaining == (0, 0) {
            if let Some(header) = line.strip_prefix("@@ ") {
                let ranges = header.split(" @@").next().unwrap_or_default();
                let mut parts = ranges.split(' ');
                let old = parts.next().and_then(|part| part.strip_prefix('-')).and_then(parse_range);
                let new = parts.next().and_then(|part| part.strip_prefix('+')).and_then(parse_range);
                let (Some((old_start, old_count)), Some((new_start, new_count))) = (old, new) else {
                    return Err(format!("unknown hunk header on line {number}: {line:?}"));
                };
                remaining = (old_count, new_count);
                hunks.push(Hunk { old_start, new_start, lines: Vec::new() });
            } else if !hunks.is_empty()
                && (line.starts_with("diff ")
                    || line.strip_prefix("---").is_some_and(|name| name.starts_with([' ', '\t'])))
            {
                // The next file, whose `---` header has a space or a tab before its name: only the first one is shown.
                break;
            }
            continue;
        }
        if line.starts_with("@@") {
            return Err(format!("the hunk before line {number} ends before its line counts"));
        }
        let hunk = hunks.last_mut().expect("counts are only set inside a hunk");
        // Some tools drop the space of an empty unchanged line.
        let (kind, content) = match line.chars().next() {
            None => (' ', ""),
            Some('\\') => continue,
            Some(kind @ (' ' | '+' | '-')) => (kind, &line[1..]),
            Some(_) => return Err(format!("unknown line {number} in a hunk: {line:?}")),
        };
        let (old, new) = &mut remaining;
        let fits = match kind {
            ' ' => *old > 0 && *new > 0,
            '-' => *old > 0,
            _ => *new > 0,
        };
        if !fits {
            return Err(format!("line {number} does not fit the hunk's line counts: {line:?}"));
        }
        if kind != '+' {
            *old -= 1;
        }
        if kind != '-' {
            *new -= 1;
        }
        hunk.lines.push((kind, content.to_owned()));
    }
    if remaining != (0, 0) {
        return Err("the last hunk ends before its line counts".to_owned());
    }
    Ok(hunks)
}

#[derive(Clone, Debug)]
struct Line {
    content: String,
    number: Option<u64>,
    kind: Kind,
}

/// The unified view's lines: new numbers for added and unchanged lines, old numbers for removed ones.
fn unified(hunks: &[Hunk]) -> (Vec<Line>, Vec<u32>) {
    let (mut lines, mut starts) = (Vec::new(), Vec::new());
    for hunk in hunks {
        starts.push(lines.len() as u32);
        let (mut old, mut new) = (hunk.old_start, hunk.new_start);
        for (kind, content) in &hunk.lines {
            let content = content.clone();
            lines.push(match kind {
                // Counters saturate: a hunk can claim any line number.
                '+' => {
                    new = new.saturating_add(1);
                    Line { content, number: Some(new - 1), kind: Kind::Added }
                }
                '-' => {
                    old = old.saturating_add(1);
                    Line { content, number: Some(old - 1), kind: Kind::Removed }
                }
                _ => {
                    (old, new) = (old.saturating_add(1), new.saturating_add(1));
                    Line { content, number: Some(new - 1), kind: Kind::Context }
                }
            });
        }
    }
    (lines, starts)
}

/// The split view's two columns, padded so each run of removed lines sits beside the added lines replacing it.
fn split(hunks: &[Hunk]) -> (Vec<Line>, Vec<Line>, Vec<u32>) {
    let (mut left, mut right, mut starts) = (Vec::new(), Vec::new(), Vec::new());
    let empty = || Line { content: String::new(), number: None, kind: Kind::Empty };
    for hunk in hunks {
        starts.push(left.len() as u32);
        let (mut old, mut new) = (hunk.old_start, hunk.new_start);
        let mut index = 0;
        while index < hunk.lines.len() {
            let (kind, content) = &hunk.lines[index];
            if *kind == ' ' {
                left.push(Line { content: content.clone(), number: Some(old), kind: Kind::Context });
                right.push(Line { content: content.clone(), number: Some(new), kind: Kind::Context });
                (old, new) = (old.saturating_add(1), new.saturating_add(1));
                index += 1;
                continue;
            }
            let (mut removed, mut added) = (Vec::new(), Vec::new());
            while let Some((kind, content)) = hunk.lines.get(index).filter(|(kind, _)| *kind != ' ') {
                if *kind == '-' {
                    removed.push(Line { content: content.clone(), number: Some(old), kind: Kind::Removed });
                    old = old.saturating_add(1);
                } else {
                    added.push(Line { content: content.clone(), number: Some(new), kind: Kind::Added });
                    new = new.saturating_add(1);
                }
                index += 1;
            }
            let rows = removed.len().max(added.len());
            left.extend(removed.into_iter().chain(std::iter::repeat_with(empty)).take(rows));
            right.extend(added.into_iter().chain(std::iter::repeat_with(empty)).take(rows));
        }
    }
    (left, right, starts)
}

/// One column: a code view inside line numbers.
struct Side {
    numbers: LineNumbers,
    code: Code,
}

impl Side {
    fn new(app: &App) -> Self {
        let code = Code::new(app).grow(1.0);
        let numbers = LineNumbers::new(app, &code).grow(1.0).basis(0).min_width(0);
        Self { numbers, code }
    }

    /// Shows lines. Unchanged text keeps its highlighting.
    fn show(&self, lines: &[Line], colors: &DiffColors, gutter: DiffGutter) {
        // As Core: the paddings and digits set the width, since a minimum width would add left padding.
        let min_after_width = if gutter.min_digits.is_some() { SIGN_WIDTH } else { 0 };
        self.numbers.gutter_layout(0, gutter.padding_left, gutter.min_digits.unwrap_or(0), min_after_width);
        let content = lines.iter().map(|line| line.content.as_str()).collect::<Vec<_>>().join("\n");
        if self.code.code() != content {
            self.code.set_code(content);
        }
        let (mut line_colors, mut signs, mut numbers, mut hidden) =
            (HashMap::new(), HashMap::new(), HashMap::new(), HashSet::new());
        let (mut added, mut removed) = (None, None);
        for (index, line) in lines.iter().enumerate() {
            let index = index as u32;
            match line.number {
                Some(number) => {
                    numbers.insert(index, number);
                }
                None => {
                    hidden.insert(index);
                }
            }
            let (gutter, content) = match line.kind {
                Kind::Added => (colors.added_line_number_bg, colors.added_content_bg.unwrap_or(colors.added_bg)),
                Kind::Removed => {
                    (colors.removed_line_number_bg, colors.removed_content_bg.unwrap_or(colors.removed_bg))
                }
                Kind::Context => (colors.line_number_bg, colors.context_content_bg.unwrap_or(colors.context_bg)),
                Kind::Empty => continue,
            };
            line_colors.insert(index, LineColor::new(gutter, content));
            let (sign, text, color) = match line.kind {
                Kind::Added => (&mut added, " +", colors.added_sign),
                Kind::Removed => (&mut removed, " -", colors.removed_sign),
                _ => continue,
            };
            signs.insert(index, Rc::clone(sign.get_or_insert_with(|| Rc::new(LineSign::after(text, color)))));
        }
        self.numbers.replace_lines(line_colors, signs, numbers, hidden);
    }
}

#[derive(Clone)]
struct State {
    text: String,
    view: DiffView,
    colors: DiffColors,
    filetype: Option<String>,
    syntax: SyntaxTheme,
    wrap: WrapMode,
    line_numbers: bool,
    gutter: DiffGutter,
}

/// Which children a [`Diff`] shows.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum Shown {
    Nothing,
    Error,
    Unified,
    Split,
}

pub(crate) struct DiffInner {
    element: Element,
    state: RefCell<State>,
    left: Side,
    right: Side,
    error_message: Text,
    error_source: Code,
    hunks: RefCell<Vec<u32>>,
    syncing: Cell<bool>,
    shown: Cell<Shown>,
    /// Set while the children change, and whether a handler changed the state meanwhile.
    rebuilding: Cell<bool>,
    stale: Cell<bool>,
}

impl Behavior for DiffInner {
    fn element(&self) -> &Element {
        &self.element
    }
}

impl DiffInner {
    /// Shows the state. Code views run scroll handlers as their text changes, and those may change this diff: no
    /// borrow is held meanwhile, and their changes show once this one is done.
    fn rebuild(&self) {
        if self.rebuilding.replace(true) {
            self.stale.set(true);
            return;
        }
        loop {
            self.stale.set(false);
            let state = self.state.borrow().clone();
            self.show_state(&state);
            if !self.stale.get() {
                break;
            }
        }
        self.rebuilding.set(false);
    }

    fn show_state(&self, state: &State) {
        for side in [&self.left, &self.right] {
            side.code.filetype(state.filetype.as_deref()).syntax_theme(state.syntax.clone()).wrap(state.wrap);
            side.numbers
                .fg(state.colors.line_number)
                .bg(state.colors.line_number_bg)
                .show_line_numbers(state.line_numbers);
        }
        let (shown, starts) = match parse(&state.text) {
            Err(error) => {
                self.error_message.set_text(format!("Error parsing diff: {error}"));
                self.error_source.syntax_theme(state.syntax.clone()).set_code(state.text.clone()).wrap(state.wrap);
                (Shown::Error, Vec::new())
            }
            Ok(hunks) if hunks.is_empty() => (Shown::Nothing, Vec::new()),
            Ok(hunks) => match state.view {
                DiffView::Unified => {
                    let (lines, starts) = unified(&hunks);
                    self.left.show(&lines, &state.colors, state.gutter);
                    (Shown::Unified, starts)
                }
                DiffView::Split => {
                    let (left, right, starts) = split(&hunks);
                    self.left.show(&left, &state.colors, state.gutter);
                    self.right.show(&right, &state.colors, state.gutter);
                    (Shown::Split, starts)
                }
            },
        };
        *self.hunks.borrow_mut() = starts;
        self.show(shown);
    }

    /// Swaps the children when what the diff shows changes. Children that stay are not detached, so they keep focus
    /// and the selection.
    fn show(&self, shown: Shown) {
        if self.shown.replace(shown) == shown {
            return;
        }
        let children = match shown {
            Shown::Nothing => vec![],
            Shown::Error => vec![self.error_message.element(), self.error_source.element()],
            Shown::Unified => vec![self.left.numbers.element()],
            Shown::Split => vec![self.left.numbers.element(), self.right.numbers.element()],
        };
        for child in self.element.child_behaviors() {
            if !children.iter().any(|kept| kept.id() == child.element().id()) {
                child.element().detach();
            }
        }
        let direction = if shown == Shown::Split { FlexDirection::Row } else { FlexDirection::Column };
        self.element.set_layout(LayoutProperty::FlexDirection(direction));
        // Split columns share the width. As in Core, the unified column is as tall as its lines, so a diff without
        // a height shows them all.
        let grow = if shown == Shown::Split { 1.0 } else { 0.0 };
        self.left.numbers.grow(grow);
        for (index, child) in children.into_iter().enumerate() {
            self.element.insert(child, Some(index));
        }
    }
}

/// A diff with line numbers, `+` and `-` signs, and colored lines, in one column or side by side.
///
/// Give it a unified diff, such as `git diff` prints. It shows the first file's hunks; a diff it cannot parse shows
/// the error and the raw text. In the split view, both columns scroll together. Setters update the code views in
/// place, so focus and a selection in them stay.
///
/// ```no_run
/// # use opentui::prelude::*;
/// # use opentui::widget::{Diff, DiffView};
/// # let app = App::new(AppOptions::default())?;
/// let diff = Diff::new(&app).view(DiffView::Split).filetype("rust").grow(1.0);
/// diff.set_diff("@@ -1,2 +1,2 @@\n fn main() {\n-    old();\n+    new();\n");
/// # Ok::<(), opentui::Error>(())
/// ```
#[derive(Clone)]
pub struct Diff(Rc<DiffInner>);

handle!(Diff, DiffInner);

impl Diff {
    /// # Panics
    ///
    /// Panics if native code cannot create its code views, as [`Code::new`] does.
    pub fn new(app: &App) -> Self {
        let theme = app.theme();
        let diff = Self(build(app, NodeKind::Box, |element| DiffInner {
            element,
            state: RefCell::new(State {
                text: String::new(),
                view: DiffView::Unified,
                colors: DiffColors::from_theme(&theme),
                filetype: None,
                syntax: SyntaxTheme::from_theme(&theme),
                wrap: WrapMode::None,
                line_numbers: true,
                gutter: DiffGutter::default(),
            }),
            left: Side::new(app),
            right: Side::new(app),
            error_message: Text::new(app, "").fg(theme.error).shrink(0.0),
            // As in Core: plain text unless the app registers a diff grammar.
            error_source: Code::new(app).filetype("diff").grow(1.0),
            hunks: RefCell::new(Vec::new()),
            syncing: Cell::new(false),
            shown: Cell::new(Shown::Nothing),
            rebuilding: Cell::new(false),
            stale: Cell::new(false),
        }));
        // Each column follows the other's scrolling.
        // Weak handles: the two views would otherwise keep each other alive after the diff is gone.
        for (from, to) in [(&diff.0.left.code, &diff.0.right.code), (&diff.0.right.code, &diff.0.left.code)] {
            let (inner, to) = (Rc::downgrade(&diff.0), Rc::downgrade(&to.0));
            from.on_scroll(move |_cx, row| {
                let (Some(inner), Some(to)) = (inner.upgrade(), to.upgrade()) else { return };
                if inner.state.borrow().view == DiffView::Split && !inner.syncing.replace(true) {
                    Code(to).scroll_to(row);
                    inner.syncing.set(false);
                }
            });
        }
        diff.0.element.set_layout(LayoutProperty::MinHeight(Length::Cells(0.0)));
        diff
    }

    fn update(&self, change: impl FnOnce(&mut State)) -> Self {
        change(&mut self.0.state.borrow_mut());
        self.0.rebuild();
        self.clone()
    }

    /// Replaces the diff.
    pub fn set_diff(&self, diff: impl Into<String>) -> Self {
        let diff = diff.into();
        self.update(|state| state.text = diff)
    }

    pub fn diff(&self) -> String {
        self.0.state.borrow().text.clone()
    }

    /// The unified view shows only the first of [`Self::code_views`], so switching to it takes focus from the second.
    pub fn view(&self, view: DiffView) -> Self {
        self.update(|state| state.view = view)
    }

    /// Highlights the code as a filetype, as [`Code::filetype`] does.
    pub fn filetype<'a>(&self, filetype: impl Into<Option<&'a str>>) -> Self {
        let filetype = filetype.into().map(str::to_owned);
        self.update(|state| state.filetype = filetype)
    }

    /// The styles for highlighted code, as [`Code::syntax_theme`].
    pub fn syntax_theme(&self, theme: SyntaxTheme) -> Self {
        self.update(|state| state.syntax = theme)
    }

    /// Wraps long lines; off by default. In the split view, a line that wraps on one side only moves the rows below
    /// it out of line with the other side.
    pub fn wrap(&self, wrap: WrapMode) -> Self {
        self.update(|state| state.wrap = wrap)
    }

    /// Shows the line number gutters; on by default.
    pub fn line_numbers(&self, show: bool) -> Self {
        self.update(|state| state.line_numbers = show)
    }

    /// Sizes the line number gutters.
    pub fn gutter(&self, gutter: DiffGutter) -> Self {
        self.update(|state| state.gutter = gutter)
    }

    pub fn colors(&self, colors: DiffColors) -> Self {
        self.update(|state| state.colors = colors)
    }

    /// The zero-based line of each hunk's first line in the code views, in order. These are lines of the text, and
    /// [`Code::scroll_to`] takes wrapped lines; without [`Self::wrap`] they are the same, so pass one to it to jump
    /// between hunks.
    pub fn hunk_lines(&self) -> Vec<u32> {
        self.0.hunks.borrow().clone()
    }

    /// The code views: the only one in the unified view, and the old file in the split view; then the new file.
    pub fn code_views(&self) -> (Code, Code) {
        (self.0.left.code.clone(), self.0.right.code.clone())
    }
}

#[cfg(test)]
mod tests {
    #[test]
    fn diffs_parse_as_in_core() {
        // Core's vectors, which its Diff test runs through DiffRenderable.
        let corpus: serde_json::Value =
            serde_json::from_str(include_str!("../../../../../core/src/renderables/diff.conformance.json")).unwrap();
        for row in corpus["rows"].as_array().unwrap() {
            let shown = super::parse(row[1].as_str().unwrap()).map_or(serde_json::json!("error"), |hunks| {
                let lines =
                    |hunk: &super::Hunk| hunk.lines.iter().map(|(kind, line)| format!("{kind}{line}")).collect();
                serde_json::json!(hunks.iter().map(lines).collect::<Vec<Vec<String>>>())
            });
            assert_eq!(shown, row[2], "{}", row[0]);
        }
    }
}
