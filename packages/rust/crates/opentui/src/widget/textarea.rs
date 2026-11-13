use super::editor::{EditorAction, EditorCore, editor_methods, extmark_methods, textarea_keymap};
use super::{Element, Widget, keymap_methods};
use super::{Extmark, ExtmarkId, ExtmarkOptions};
use crate::app::{App, Cx};
use crate::input::Keymap;
use crate::native::{EditBuffer, EditorView, SelectionColors, SyntaxStyle, WrapMode};
use crate::style::Color;
use crate::syntax::SyntaxTheme;
use std::rc::Rc;

/// Multi-line text editing with Core's key bindings, undo, wrapping, mouse selection, and paste.
///
/// The area grows with its content unless its height is set. Alt+Enter calls [`Self::on_submit`]. Change the keys
/// with [`Self::bind`] and [`Self::unbind`]; [`EditorAction`] lists what they can do.
///
/// With the `tree-sitter` feature, [`Self::filetype`] highlights the text as it is edited; see
/// [`syntax`](crate::syntax).
///
/// ```no_run
/// # use opentui::prelude::*;
/// # let app = App::new(AppOptions::default())?;
/// let notes = Textarea::new(&app).placeholder("Write something...").grow(1.0);
/// notes.on_change(|_cx, text| eprintln!("{} bytes", text.len()));
/// # Ok::<(), opentui::Error>(())
/// ```
#[derive(Clone)]
pub struct Textarea(Rc<EditorCore>);

impl Widget for Textarea {
    fn element(&self) -> &Element {
        &self.0.element
    }
}

impl std::fmt::Debug for Textarea {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter.debug_tuple("Textarea").field(&self.0.element.id()).finish()
    }
}

impl Textarea {
    /// # Panics
    ///
    /// Panics if native code cannot create the edit buffer, which happens only once the app's native limits are
    /// exhausted.
    pub fn new(app: &App) -> Self {
        Self(EditorCore::build(app, false))
    }

    /// The key bindings a new textarea starts with: Core's Textarea bindings.
    pub fn default_keymap() -> Keymap<EditorAction> {
        textarea_keymap()
    }

    keymap_methods!(EditorAction);

    /// Runs an editing action as its key would, including change and submit handlers.
    pub fn perform(&self, action: EditorAction) -> Self {
        self.0.perform(action);
        self.clone()
    }

    pub fn text(&self) -> String {
        self.0.text()
    }

    /// Replaces the text, clears undo history, and moves the cursor to the end. Does not call change handlers.
    pub fn set_text(&self, text: impl AsRef<str>) -> Self {
        self.0.set_text(text.as_ref());
        self.clone()
    }

    /// Inserts text at the cursor as an undoable edit, replacing any selection, and calls change handlers.
    pub fn insert(&self, text: impl AsRef<str>) -> Self {
        self.0.insert_notifying(text.as_ref());
        self.clone()
    }

    extmark_methods!();

    editor_methods!();

    pub fn wrap(&self, wrap: WrapMode) -> Self {
        self.0.report(self.0.view.set_wrap(wrap));
        self.clone()
    }

    /// Highlights the text as a filetype, such as `"rust"`, or shows it plain with `None`. Extensions, file names,
    /// and fence tags work too: `"rs"`, `"main.rs"`, `"ts"`. It needs the `tree-sitter` feature and a grammar for the
    /// filetype; without them the text is plain. See [`syntax`](crate::syntax).
    ///
    /// The whole text is highlighted at the start of the next frame after it changes, so any number of edits between
    /// frames costs one highlight, and frames without edits cost none. Extmark styles draw over highlighting.
    pub fn filetype<'a>(&self, filetype: impl Into<Option<&'a str>>) -> Self {
        self.0.set_filetype(filetype.into());
        self.clone()
    }

    /// The styles for highlighted text. It starts as [`SyntaxTheme::from_theme`] for the app's theme.
    pub fn syntax_theme(&self, theme: SyntaxTheme) -> Self {
        self.0.set_syntax_theme(theme);
        self.clone()
    }

    /// The native style table for highlights added with [`EditBuffer::highlight`], such as one from
    /// [`SyntaxTheme::to_syntax_style`]. Without one, the textarea makes its own.
    ///
    /// The textarea registers the styles of [`Self::filetype`] highlighting and of extmarks in this table, under
    /// names that start with `opentui.`: each capture name as `opentui.<capture>`, with its [`Self::syntax_theme`]
    /// style. Textareas that share a table share one syntax theme: the one set last on any of them, here or with
    /// [`Self::syntax_theme`], restyles them all. Highlighting draws on layer 1 and extmarks above it, under tag 65535;
    /// text the theme leaves plain lets your own priority-0 highlights show.
    pub fn syntax_style(&self, style: &SyntaxStyle) -> Self {
        self.0.set_syntax_style(style);
        self.clone()
    }

    /// Called on Alt+Enter, or another key bound to [`EditorAction::Submit`], with the current text.
    pub fn on_submit(&self, mut handler: impl FnMut(&mut Cx<'_>, &str) + 'static) -> Self {
        self.0.on_submit.add(move |cx, text: &str| handler(cx, text));
        self.clone()
    }

    /// The cursor as (row, display column).
    pub fn cursor(&self) -> (u32, u32) {
        self.0.report(self.0.buffer.info()).map_or((0, 0), |info| info.cursor)
    }

    /// The native buffer, for highlights and other operations this widget does not wrap. Edits made through it
    /// bypass the widget: they are not cut to [`Self::max_length`], do not move extmarks, and do not call change
    /// handlers.
    pub fn buffer(&self) -> &EditBuffer {
        &self.0.buffer
    }

    pub fn view(&self) -> &EditorView {
        &self.0.view
    }
}
