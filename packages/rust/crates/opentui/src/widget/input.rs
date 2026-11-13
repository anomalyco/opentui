use super::editor::{EditorAction, EditorCore, editor_methods, extmark_methods, input_keymap};
use super::{Element, Widget, keymap_methods};
use super::{Extmark, ExtmarkId, ExtmarkOptions};
use crate::app::{App, Cx};
use crate::input::Keymap;
use crate::native::SelectionColors;
use crate::style::Color;
use std::rc::Rc;

/// A single-line text field with Core's editing keys, undo, mouse selection, and paste.
///
/// Enter calls [`Self::on_submit`]. Line breaks in typed or pasted text are dropped. Change the keys with
/// [`Self::bind`] and [`Self::unbind`]; [`EditorAction`] lists what they can do.
///
/// ```no_run
/// # use opentui::prelude::*;
/// # let app = App::new(AppOptions::default())?;
/// let name = Input::new(&app).placeholder("Your name").width(30);
/// name.on_submit(|_cx, value| println!("hello, {value}"));
/// # Ok::<(), opentui::Error>(())
/// ```
#[derive(Clone)]
pub struct Input(pub(crate) Rc<EditorCore>);

impl Widget for Input {
    fn element(&self) -> &Element {
        &self.0.element
    }
}

impl std::fmt::Debug for Input {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter.debug_tuple("Input").field(&self.0.element.id()).finish()
    }
}

impl Input {
    /// # Panics
    ///
    /// Panics if native code cannot create the edit buffer, which happens only once the app's native limits are
    /// exhausted.
    pub fn new(app: &App) -> Self {
        Self(EditorCore::build(app, true))
    }

    /// The key bindings a new input starts with: Core's Input bindings.
    pub fn default_keymap() -> Keymap<EditorAction> {
        input_keymap()
    }

    keymap_methods!(EditorAction);

    /// Runs an editing action as its key would, including change and submit handlers.
    pub fn perform(&self, action: EditorAction) -> Self {
        self.0.perform(action);
        self.clone()
    }

    /// The current single-line text. Rust string indices count UTF-8 bytes, not cursor cells.
    pub fn value(&self) -> String {
        self.0.text()
    }

    /// Replaces the text, clears undo history, and moves the cursor to the end. Does not call change handlers.
    pub fn set_value(&self, value: impl AsRef<str>) -> Self {
        self.0.set_text(value.as_ref());
        self.clone()
    }

    /// Inserts text at the cursor as an undoable edit, replacing any selection, and calls change handlers. Line
    /// breaks are dropped.
    pub fn insert(&self, text: impl AsRef<str>) -> Self {
        self.0.insert_notifying(text.as_ref());
        self.clone()
    }

    extmark_methods!();

    editor_methods!();

    /// Called when Enter is pressed, with the current text.
    pub fn on_submit(&self, mut handler: impl FnMut(&mut Cx<'_>, &str) + 'static) -> Self {
        self.0.on_submit.add(move |cx, text: &str| handler(cx, text));
        self.clone()
    }

    /// The native edit buffer, for operations this widget does not wrap. Edits made through it bypass the widget:
    /// they are not cut to [`Self::max_length`], do not move extmarks, and do not call change handlers.
    pub fn buffer(&self) -> &crate::native::EditBuffer {
        &self.0.buffer
    }
}
