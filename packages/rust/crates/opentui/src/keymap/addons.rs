//! Behaviors OpenCode's TUI installs on a keymap, ported from `@opentui/keymap/addons`.
//!
//! Unlike `@opentui/keymap`, these are not reference-counted: each call registers once more.

use super::{Binding, Command, Condition, Disposer, Expansion, Key, Keymap, Layer, Stroke, WeakKeymap};
use crate::input::KeyCode;
use crate::widget::EditorAction;
use std::cell::Cell;
use std::rc::Rc;
use std::time::{Duration, Instant};

/// Splits keys such as `"ctrl+c,ctrl+d"` into one binding per key.
pub fn comma_bindings<T: Clone + PartialEq + 'static>(keymap: &Keymap<T>) -> Disposer {
    keymap.append_binding_expander(|input| {
        if !input.input.contains(',') {
            return Ok(None);
        }
        let parts: Vec<&str> = input.input.split(',').map(str::trim).collect();
        if parts.iter().any(|part| part.is_empty()) {
            return Err(format!(
                "Invalid key sequence \"{}\": comma-separated bindings cannot contain empty entries",
                input.input
            ));
        }
        let plain = || parts.iter().map(|key| Expansion { key: (*key).to_owned(), displays: None }).collect();
        let Some(displays) = input.displays else { return Ok(Some(plain())) };
        let displays: Vec<String> = match displays {
            [single] => single.split(',').map(|part| part.trim().to_owned()).collect(),
            displays => displays.to_vec(),
        };
        if displays.len() != parts.len() || displays.iter().any(|display| display.trim().is_empty()) {
            return Ok(Some(plain()));
        }
        Ok(Some(
            parts
                .iter()
                .zip(displays)
                .map(|(key, display)| Expansion {
                    key: (*key).to_owned(),
                    displays: Some(display.split_whitespace().map(str::to_owned).collect()),
                })
                .collect(),
        ))
    })
}

/// Replaces key name aliases, such as `enter` with `return`, where they stand alone between `+`, `,`, spaces, and
/// token brackets. OpenCode's TUI installs this with `enter`, `esc`, `pgdown`, and `pgup`.
pub fn key_aliases<T: Clone + PartialEq + 'static>(keymap: &Keymap<T>, aliases: &[(&str, &str)]) -> Disposer {
    let aliases: Vec<(String, String)> =
        aliases.iter().map(|(alias, value)| ((*alias).to_owned(), (*value).to_owned())).collect();
    keymap.append_binding_expander(move |input| {
        let key = aliases.iter().fold(input.input.to_owned(), |key, (alias, value)| replace_alias(&key, alias, value));
        if key == input.input {
            return Ok(None);
        }
        Ok(Some(vec![Expansion { key, displays: input.displays.map(<[String]>::to_vec) }]))
    })
}

/// `@opentui/keymap`'s alias pattern, `(^|[+,\s>])alias(?=$|[+,\s<])`, ignoring ASCII case.
fn replace_alias(input: &str, alias: &str, value: &str) -> String {
    let mut output = String::with_capacity(input.len());
    let mut index = 0;
    while index < input.len() {
        let rest = &input[index..];
        let starts = index == 0
            || input[..index].ends_with(|character: char| "+,>".contains(character) || character.is_whitespace());
        let matches =
            rest.len() >= alias.len() && rest.as_bytes()[..alias.len()].eq_ignore_ascii_case(alias.as_bytes());
        let ends = matches
            && rest[alias.len()..].chars().next().is_none_or(|next| "+,<".contains(next) || next.is_whitespace());
        if starts && ends {
            output.push_str(value);
            index += alias.len();
            continue;
        }
        let character = rest.chars().next().expect("index is inside the input");
        output.push(character);
        index += character.len_utf8();
    }
    output
}

/// Also matches a key from a non-Latin layout by the key at the same position on a US layout, when the terminal
/// reports it: Korean Ctrl+ㅊ matches `ctrl+c`, and AZERTY Ctrl+& matches `ctrl+1`, but Dvorak Ctrl+J stays Ctrl+J.
pub fn base_layout_fallback<T: Clone + PartialEq + 'static>(keymap: &Keymap<T>) -> Disposer {
    keymap.append_event_match_resolver(|event| {
        let base = event.base_layout?;
        if base as u32 <= 32 || base as u32 == 127 {
            return None;
        }
        let typed_non_ascii = matches!(event.code, KeyCode::Char(character) if !character.is_ascii());
        if !typed_non_ascii && !base.is_ascii_digit() {
            return None;
        }
        let stroke = Stroke::from_event(event);
        Some(vec![Stroke { name: base.to_ascii_lowercase().to_string(), ..stroke }])
    })
}

/// Lets Escape cancel a pending sequence. Consumes the Escape when it does.
pub fn escape_clears_pending_sequence<T: Clone + PartialEq + 'static>(keymap: &Keymap<T>, priority: i32) -> Disposer {
    keymap.intercept_key(priority, false, |context| {
        if context.stroke.name != "escape" || !context.keymap.has_pending_sequence() {
            return;
        }
        context.keymap.clear_pending_sequence();
        context.consume();
    })
}

/// Lets Backspace remove the last stroke of a pending sequence. Consumes the Backspace when it does.
pub fn backspace_pops_pending_sequence<T: Clone + PartialEq + 'static>(keymap: &Keymap<T>, priority: i32) -> Disposer {
    keymap.intercept_key(priority, false, |context| {
        if context.stroke.name == "backspace" && context.keymap.pop_pending_sequence() {
            context.consume();
        }
    })
}

/// Registers a token such as `leader` for `trigger`, which bindings name as `<leader>`.
pub fn leader<T: Clone + PartialEq + 'static>(keymap: &Keymap<T>, name: &str, trigger: impl Into<Key>) -> Disposer {
    keymap.register_token(name, trigger)
}

/// A leader token whose pending sequence clears when no key follows in time. The keymap has no clock: schedule a
/// timer for [`deadline`](Self::deadline) and call [`expire`](Self::expire) when it fires. Dropping it removes the
/// token, as [`dispose`](Self::dispose) does.
#[must_use = "dropping a TimedLeader removes its token"]
pub struct TimedLeader<T> {
    keymap: WeakKeymap<T>,
    deadline: Rc<Cell<Option<Instant>>>,
    disposer: Disposer,
}

/// Registers a leader token, as [`leader`] does, and arms a timeout whenever a pending sequence starts with the
/// trigger. Each further stroke restarts the timeout. `@opentui/keymap` defaults the timeout to 1,500 ms; OpenCode
/// uses 2,000 ms.
pub fn timed_leader<T: Clone + PartialEq + 'static>(
    keymap: &Keymap<T>,
    name: &str,
    trigger: impl Into<Key>,
    timeout: Duration,
) -> Result<TimedLeader<T>, String> {
    let trigger = trigger.into();
    let trigger_stroke = keymap.parse_key(trigger.clone())?.stroke;
    let deadline = Rc::new(Cell::new(None));
    let sync = {
        let deadline = deadline.clone();
        move |sequence: &[super::KeySequencePart]| {
            let armed = sequence.first().is_some_and(|part| part.stroke == trigger_stroke);
            deadline.set(armed.then(|| Instant::now() + timeout));
        }
    };
    let token = leader(keymap, name, trigger);
    sync(&keymap.pending_sequence());
    let listener = keymap.on_pending_sequence(sync);
    Ok(TimedLeader { keymap: keymap.downgrade(), deadline, disposer: Disposer::all(vec![token, listener]) })
}

impl<T: Clone + PartialEq + 'static> TimedLeader<T> {
    /// When the leader sequence expires, while one is pending.
    pub fn deadline(&self) -> Option<Instant> {
        self.deadline.get()
    }

    /// Clears the leader sequence if `now` is past its deadline. Returns whether it did.
    pub fn expire(&self, now: Instant) -> bool {
        if self.deadline.get().is_none_or(|deadline| now < deadline) {
            return false;
        }
        self.deadline.set(None);
        if let Some(keymap) = self.keymap.upgrade() {
            keymap.clear_pending_sequence();
        }
        true
    }

    pub fn dispose(self) {
        self.deadline.set(None);
        self.disposer.dispose();
    }
}

/// The edit commands, their names, and their descriptions, as `@opentui/keymap`'s edit-buffer addon names them.
pub const EDIT_COMMANDS: &[(EditorAction, &str, &str)] = &[
    (EditorAction::MoveLeft, "input.move.left", "Cursor left"),
    (EditorAction::MoveRight, "input.move.right", "Cursor right"),
    (EditorAction::MoveUp, "input.move.up", "Cursor up"),
    (EditorAction::MoveDown, "input.move.down", "Cursor down"),
    (EditorAction::SelectLeft, "input.select.left", "Select left"),
    (EditorAction::SelectRight, "input.select.right", "Select right"),
    (EditorAction::SelectUp, "input.select.up", "Select up"),
    (EditorAction::SelectDown, "input.select.down", "Select down"),
    (EditorAction::LineHome, "input.line.home", "Line start"),
    (EditorAction::LineEnd, "input.line.end", "Line end"),
    (EditorAction::SelectLineHome, "input.select.line.home", "Select to line start"),
    (EditorAction::SelectLineEnd, "input.select.line.end", "Select to line end"),
    (EditorAction::VisualLineHome, "input.visual.line.home", "Visual line start"),
    (EditorAction::VisualLineEnd, "input.visual.line.end", "Visual line end"),
    (EditorAction::SelectVisualLineHome, "input.select.visual.line.home", "Select to visual line start"),
    (EditorAction::SelectVisualLineEnd, "input.select.visual.line.end", "Select to visual line end"),
    (EditorAction::BufferHome, "input.buffer.home", "Buffer start"),
    (EditorAction::BufferEnd, "input.buffer.end", "Buffer end"),
    (EditorAction::SelectBufferHome, "input.select.buffer.home", "Select to buffer start"),
    (EditorAction::SelectBufferEnd, "input.select.buffer.end", "Select to buffer end"),
    (EditorAction::DeleteLine, "input.delete.line", "Delete line"),
    (EditorAction::DeleteToLineEnd, "input.delete.to.line.end", "Delete to line end"),
    (EditorAction::DeleteToLineStart, "input.delete.to.line.start", "Delete to line start"),
    (EditorAction::Backspace, "input.backspace", "Delete backward"),
    (EditorAction::Delete, "input.delete", "Delete forward"),
    (EditorAction::Newline, "input.newline", "New line"),
    (EditorAction::Undo, "input.undo", "Undo"),
    (EditorAction::Redo, "input.redo", "Redo"),
    (EditorAction::WordForward, "input.word.forward", "Next word"),
    (EditorAction::WordBackward, "input.word.backward", "Previous word"),
    (EditorAction::SelectWordForward, "input.select.word.forward", "Select next word"),
    (EditorAction::SelectWordBackward, "input.select.word.backward", "Select previous word"),
    (EditorAction::DeleteWordForward, "input.delete.word.forward", "Delete next word"),
    (EditorAction::DeleteWordBackward, "input.delete.word.backward", "Delete previous word"),
    (EditorAction::SelectAll, "input.select.all", "Select all"),
    (EditorAction::Submit, "input.submit", "Submit"),
];

/// Core's default textarea bindings (`defaultTextareaKeyBindings`), in binding syntax.
pub const TEXTAREA_BINDINGS: &[(&str, EditorAction)] = &[
    ("left", EditorAction::MoveLeft),
    ("right", EditorAction::MoveRight),
    ("up", EditorAction::MoveUp),
    ("down", EditorAction::MoveDown),
    ("shift+left", EditorAction::SelectLeft),
    ("shift+right", EditorAction::SelectRight),
    ("shift+up", EditorAction::SelectUp),
    ("shift+down", EditorAction::SelectDown),
    ("home", EditorAction::BufferHome),
    ("end", EditorAction::BufferEnd),
    ("shift+home", EditorAction::SelectBufferHome),
    ("shift+end", EditorAction::SelectBufferEnd),
    ("ctrl+a", EditorAction::LineHome),
    ("ctrl+e", EditorAction::LineEnd),
    ("ctrl+shift+a", EditorAction::SelectLineHome),
    ("ctrl+shift+e", EditorAction::SelectLineEnd),
    ("meta+a", EditorAction::VisualLineHome),
    ("meta+e", EditorAction::VisualLineEnd),
    ("shift+meta+a", EditorAction::SelectVisualLineHome),
    ("shift+meta+e", EditorAction::SelectVisualLineEnd),
    ("ctrl+f", EditorAction::MoveRight),
    ("ctrl+b", EditorAction::MoveLeft),
    ("ctrl+w", EditorAction::DeleteWordBackward),
    ("ctrl+backspace", EditorAction::DeleteWordBackward),
    ("meta+d", EditorAction::DeleteWordForward),
    ("meta+delete", EditorAction::DeleteWordForward),
    ("ctrl+delete", EditorAction::DeleteWordForward),
    ("ctrl+shift+d", EditorAction::DeleteLine),
    ("ctrl+k", EditorAction::DeleteToLineEnd),
    ("ctrl+u", EditorAction::DeleteToLineStart),
    ("backspace", EditorAction::Backspace),
    ("shift+backspace", EditorAction::Backspace),
    ("ctrl+d", EditorAction::Delete),
    ("delete", EditorAction::Delete),
    ("shift+delete", EditorAction::Delete),
    ("return", EditorAction::Newline),
    ("kpenter", EditorAction::Newline),
    ("linefeed", EditorAction::Newline),
    ("meta+return", EditorAction::Submit),
    ("meta+kpenter", EditorAction::Submit),
    ("ctrl+-", EditorAction::Undo),
    ("ctrl+.", EditorAction::Redo),
    ("super+z", EditorAction::Undo),
    ("shift+super+z", EditorAction::Redo),
    ("meta+f", EditorAction::WordForward),
    ("meta+b", EditorAction::WordBackward),
    ("meta+right", EditorAction::WordForward),
    ("meta+left", EditorAction::WordBackward),
    ("ctrl+right", EditorAction::WordForward),
    ("ctrl+left", EditorAction::WordBackward),
    ("shift+meta+f", EditorAction::SelectWordForward),
    ("shift+meta+b", EditorAction::SelectWordBackward),
    ("shift+meta+right", EditorAction::SelectWordForward),
    ("shift+meta+left", EditorAction::SelectWordBackward),
    ("meta+backspace", EditorAction::DeleteWordBackward),
    ("super+left", EditorAction::VisualLineHome),
    ("super+right", EditorAction::VisualLineEnd),
    ("super+up", EditorAction::BufferHome),
    ("super+down", EditorAction::BufferEnd),
    ("super+backspace", EditorAction::DeleteToLineStart),
    ("shift+super+left", EditorAction::SelectVisualLineHome),
    ("shift+super+right", EditorAction::SelectVisualLineEnd),
    ("shift+super+up", EditorAction::SelectBufferHome),
    ("shift+super+down", EditorAction::SelectBufferEnd),
    ("super+a", EditorAction::SelectAll),
];

const TEXT_EDITING: &str = "Text Editing";

fn edit_command(action: EditorAction) -> (&'static str, &'static str) {
    EDIT_COMMANDS
        .iter()
        .find(|(candidate, ..)| *candidate == action)
        .map(|&(_, name, desc)| (name, desc))
        .expect("every textarea binding has an edit command")
}

/// A layer that edits the focused textarea through the keymap, as `registerManagedTextareaLayer` does.
pub struct ManagedTextarea<T> {
    /// When the bindings apply, such as while a textarea has focus.
    pub enabled: Condition,
    /// Bindings that come before Core's defaults, such as the app's configured `input.*` keys.
    pub bindings: Vec<Binding<T>>,
    /// Performs an action on the focused editor; returns whether one did.
    pub run: Rc<dyn Fn(EditorAction) -> bool>,
}

/// Registers the `input.*` commands, always reachable, and a layer with `textarea.bindings` followed by Core's default
/// textarea bindings. The app turns off the textarea's own key handling while the layer is enabled.
pub fn managed_textarea_layer<T: Clone + PartialEq + 'static>(
    keymap: &Keymap<T>,
    textarea: ManagedTextarea<T>,
) -> Disposer {
    let commands = EDIT_COMMANDS.iter().map(|&(action, name, desc)| {
        let run = textarea.run.clone();
        Command::new(name, move |_| run(action)).desc(desc).category(TEXT_EDITING)
    });
    let defaults = TEXTAREA_BINDINGS.iter().map(|&(key, action)| {
        let (name, desc) = edit_command(action);
        Binding::new(key).cmd(name).desc(desc).group(TEXT_EDITING)
    });
    let commands = keymap.register_layer(Layer::new().commands(commands));
    let bindings =
        keymap.register_layer(Layer::new().enabled(textarea.enabled).bindings(textarea.bindings).bindings(defaults));
    Disposer::all(vec![commands, bindings])
}
