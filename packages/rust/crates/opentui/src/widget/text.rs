use super::{Behavior, Content, Element, SelectionUpdate, build, handle};
use crate::app::App;
use crate::native::{NodeKind, SelectionColors, WrapMode};
use crate::style::{Alignment, Attributes, Color};
use std::cell::Cell;
use std::hash::{DefaultHasher, Hash, Hasher};
use std::rc::Rc;

pub(crate) struct TextInner {
    element: Element,
    selectable: Cell<bool>,
    selection_colors: Cell<SelectionColors>,
    /// A hash of the content last set, so setting equal content again skips the native rebuild.
    content: Cell<Option<u64>>,
}

impl Behavior for TextInner {
    fn element(&self) -> &Element {
        &self.element
    }

    fn selectable(&self) -> bool {
        self.selectable.get()
    }

    fn select(&self, selection: Option<&SelectionUpdate>) -> bool {
        let Some(selection) = selection else {
            self.element.apply(|node| node.clear_text_selection().map(drop));
            return false;
        };
        let (anchor, focus) = selection.local(&self.element);
        let colors = self.selection_colors.get();
        self.element.apply(|node| node.select_text(anchor, focus, !selection.start, selection.unit, colors).map(drop));
        self.element.query(|node| node.text_selection()).flatten().is_some()
    }

    fn selected_text(&self) -> Option<String> {
        self.element.query(|node| node.selected_text())
    }
}

/// Styled text that wraps to its width.
///
/// ```no_run
/// # use opentui::prelude::*;
/// # let app = App::new(AppOptions::default())?;
/// let title = Text::new(&app, "OpenTUI").fg(Color::CYAN).bold();
/// let status = Text::new(&app, vec!["Build ".into(), "passed".fg(Color::GREEN)]);
/// status.set_text("Build running");
/// # Ok::<(), opentui::Error>(())
/// ```
#[derive(Clone)]
pub struct Text(Rc<TextInner>);

handle!(Text, TextInner);

impl Text {
    pub fn new(app: &App, content: impl Into<Content>) -> Self {
        let theme = app.theme();
        let text = Self(build(app, NodeKind::Text, |element| TextInner {
            element,
            selectable: Cell::new(true),
            selection_colors: Cell::new(SelectionColors { fg: Some(theme.selection_fg), bg: Some(theme.selection_bg) }),
            content: Cell::new(None),
        }));
        text.0.element.update_text_options(|options| options.fg = theme.foreground);
        text.set_text(content)
    }

    /// Replaces the content.
    pub fn set_text(&self, content: impl Into<Content>) -> Self {
        let content = content.into();
        let mut hasher = DefaultHasher::new();
        for span in &content.0 {
            (&span.content, span.style, &span.link).hash(&mut hasher);
        }
        let hash = Some(hasher.finish());
        if self.0.element.cached() && self.0.content.replace(hash) == hash {
            return self.clone();
        }
        if content.is_plain() {
            let plain = content.plain_text();
            self.0.element.apply(|node| node.set_text(plain));
        } else {
            self.0.element.apply(|node| node.set_spans(&content.0));
        }
        self.clone()
    }

    /// The plain text, with line endings normalized to `\n`.
    pub fn text(&self) -> String {
        self.0.element.query(|node| node.text()).unwrap_or_default()
    }

    /// The color of text without a span color.
    pub fn fg(&self, color: Color) -> Self {
        self.0.element.update_text_options(|options| options.fg = color);
        self.clone()
    }

    /// The background of text without a span background.
    pub fn bg(&self, color: Color) -> Self {
        self.0.element.update_text_options(|options| options.bg = color);
        self.clone()
    }

    pub fn attributes(&self, attributes: Attributes) -> Self {
        self.0.element.update_text_options(|options| options.attributes = attributes);
        self.clone()
    }

    pub fn bold(&self) -> Self {
        self.add_attributes(Attributes::BOLD)
    }

    pub fn dim(&self) -> Self {
        self.add_attributes(Attributes::DIM)
    }

    pub fn italic(&self) -> Self {
        self.add_attributes(Attributes::ITALIC)
    }

    pub fn underline(&self) -> Self {
        self.add_attributes(Attributes::UNDERLINE)
    }

    pub fn inverse(&self) -> Self {
        self.add_attributes(Attributes::INVERSE)
    }

    pub fn strikethrough(&self) -> Self {
        self.add_attributes(Attributes::STRIKETHROUGH)
    }

    fn add_attributes(&self, attributes: Attributes) -> Self {
        self.0.element.update_text_options(|options| options.attributes |= attributes);
        self.clone()
    }

    pub fn wrap(&self, wrap: WrapMode) -> Self {
        self.0.element.update_text_options(|options| options.wrap = wrap);
        self.clone()
    }

    /// Cuts lines that do not fit instead of wrapping or overflowing.
    pub fn truncate(&self, truncate: bool) -> Self {
        self.0.element.update_text_options(|options| options.truncate = truncate);
        self.clone()
    }

    pub fn align(&self, alignment: Alignment) -> Self {
        self.0.element.update_text_options(|options| options.align = alignment);
        self.clone()
    }

    /// Whether the mouse can select the text, alone or as part of a selection across widgets. On by default. See
    /// [`App::selected_text`].
    pub fn selectable(&self, selectable: bool) -> Self {
        self.0.selectable.set(selectable);
        self.clone()
    }

    pub fn selection_colors(&self, colors: SelectionColors) -> Self {
        self.0.selection_colors.set(colors);
        self.clone()
    }

    /// Scrolls the text by display columns and wrapped rows.
    pub fn scroll_to(&self, x: f64, y: f64) -> Self {
        self.0.element.update_text_options(|options| options.scroll = (x, y));
        self.clone()
    }

    /// This text's part of the mouse selection, or an empty string.
    pub fn selected_text(&self) -> String {
        self.0.selected_text().unwrap_or_default()
    }

    /// Text measurements: lines before and after wrapping, and widths in display columns.
    pub fn info(&self) -> crate::native::TextInfo {
        self.0.element.query(|node| node.text_info()).unwrap_or_default()
    }
}

#[cfg(test)]
mod tests {
    use crate::prelude::*;
    use crate::testing::TestApp;

    fn byte(text: &Text, x: i32, y: i32) -> Option<u32> {
        text.0.element.query(|node| node.text_byte_at(x, y)).flatten()
    }

    #[test]
    fn bytes_answer_only_for_what_the_last_frame_painted() {
        type Setup = fn(&TestApp) -> (Text, Option<fn(&Text)>);
        type Cells = &'static [(i32, i32, Option<u32>)];
        // Each case builds a text and renders it, optionally changes it without rendering, and checks cells:
        // (x, y, byte) after the change and, where given, after the next frame.
        let cases: [(&str, Setup, Cells, Cells); 16] = [
            ("painted", |app| (Text::new(app, "hello"), None), &[(0, 0, Some(0)), (4, 0, Some(4)), (5, 0, None)], &[]),
            ("hidden", |app| (Text::new(app, "hello"), Some(|text| drop(text.visible(false)))), &[], &[(0, 0, None)]),
            ("detached", |app| (Text::new(app, "hello"), Some(|text| text.detach())), &[], &[(0, 0, None)]),
            (
                "transparent",
                |app| (Text::new(app, "hello"), Some(|text| drop(text.opacity(0.0)))),
                &[],
                &[(0, 0, None)],
            ),
            (
                "in a transparent parent",
                |app| {
                    let text = Text::new(app, "hello");
                    app.root().add(&View::new(app).opacity(0.0).child(&text));
                    (text, None)
                },
                &[(0, 0, None)],
                &[],
            ),
            (
                "edited",
                |app| (Text::new(app, "A"), Some(|text| drop(text.set_text("ABCDE")))),
                &[(0, 0, None), (1, 0, None)],
                &[(1, 0, Some(1))],
            ),
            (
                "realigned",
                |app| (Text::new(app, "abcde").width(8), Some(|text| drop(text.align(Alignment::Right)))),
                &[(4, 0, None)],
                &[(4, 0, Some(1)), (2, 0, None)],
            ),
            (
                "scrolled",
                |app| {
                    (
                        Text::new(app, "abcdefghij\nklmnopqrst\nuvwxyz").wrap(WrapMode::None).width(4).height(2),
                        Some(|text| drop(text.scroll_to(2.0, 1.0))),
                    )
                },
                &[(0, 0, None)],
                &[(0, 0, Some(13)), (3, 1, Some(27)), (4, 0, None), (0, 2, None)],
            ),
            ("one row", |app| (Text::new(app, "AAA\nBBB").height(1), None), &[(0, 0, Some(0)), (0, 1, None)], &[]),
            (
                "wide cut by scrolling",
                |app| (Text::new(app, "\u{4e2d}a").wrap(WrapMode::None).width(3).scroll_to(1.0, 0.0), None),
                &[(0, 0, None), (1, 0, Some(3))],
                &[],
            ),
            (
                "wide cut by width",
                |app| (Text::new(app, "a\u{4e2d}").wrap(WrapMode::None).width(2), None),
                &[(0, 0, Some(0)), (1, 0, None)],
                &[],
            ),
            ("wide wider than the text", |app| (Text::new(app, "\u{4e2d}").width(1), None), &[(0, 0, None)], &[]),
            (
                "wide cut by translation",
                |app| {
                    let text = Text::new(app, "\u{4e2d}a");
                    app.root().add(&View::new(app).translate(-1.0, 0.0).child(&text));
                    (text, None)
                },
                &[(0, 0, None), (1, 0, Some(3))],
                &[],
            ),
            (
                "wide cut by a clip",
                |app| {
                    let text = Text::new(app, "a\u{4e2d}b").width(4);
                    app.root().add(&View::new(app).width(2).overflow(Overflow::Hidden).child(&text));
                    (text, None)
                },
                &[(0, 0, Some(0)), (1, 0, None), (2, 0, None)],
                &[],
            ),
            (
                "rows cut by a clip",
                |app| {
                    let text = Text::new(app, "a\nb\nc").height(3).shrink(0.0);
                    app.root().add(&View::new(app).height(1).overflow(Overflow::Hidden).child(&text));
                    (text, None)
                },
                &[(0, 0, Some(0)), (0, 1, None)],
                &[],
            ),
            (
                // A wider layout re-wraps the text at the next frame, not before.
                "widened",
                |app| (Text::new(app, "hello world").width(5), Some(|text| drop(text.width(11)))),
                &[(0, 1, Some(6)), (5, 0, None)],
                &[(6, 0, Some(6)), (0, 1, None)],
            ),
        ];
        for (name, setup, before, after) in cases {
            let app = TestApp::new(12, 4);
            let (text, change) = setup(&app);
            if text.element().parent_behavior().is_none() {
                app.root().add(&text);
            }
            app.render();
            if let Some(change) = change {
                change(&text);
            }
            for &(x, y, expected) in before {
                assert_eq!(byte(&text, x, y), expected, "{name}: ({x}, {y}) before the next frame");
            }
            app.render();
            for &(x, y, expected) in after {
                assert_eq!(byte(&text, x, y), expected, "{name}: ({x}, {y}) after the next frame");
            }
        }
        // Never painted, and culled out of a scroll box.
        let app = TestApp::new(12, 4);
        let text = Text::new(&app, "hello");
        app.root().add(&text);
        assert_eq!(byte(&text, 0, 0), None);
        let items: Vec<Text> = (0..10).map(|row| Text::new(&app, format!("item {row}"))).collect();
        let scroll = ScrollBox::new(&app).height(2);
        for item in &items {
            scroll.add(item);
        }
        app.root().add(&scroll);
        scroll.scroll_to(0.0, 7.0);
        app.render();
        assert!((-8..4).all(|y| byte(&items[0], 0, y).is_none()), "culled");
    }

    #[test]
    fn equal_values_leave_the_frame_alone() {
        let app = TestApp::new(10, 2);
        let text = Text::new(&app, vec!["Open".fg(Color::RED), " TUI".into()]).fg(Color::GREEN);
        app.root().add(&text);
        app.render();
        text.set_text(vec!["Open".fg(Color::RED), " TUI".into()]).fg(Color::GREEN).visible(true).opacity(1.0);
        assert!(!app.needs_frame());
        text.set_text("Open TUI");
        assert!(app.needs_frame());
        assert_eq!(app.text(), "Open TUI\n");
        text.visible(false);
        assert!(app.needs_frame());
        app.render();
        text.visible(false);
        assert!(!app.needs_frame());
    }
}
