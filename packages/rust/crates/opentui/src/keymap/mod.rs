//! Layered key bindings and named commands: a port of OpenTUI's `@opentui/keymap`.
//!
//! A [`Keymap`] holds [`Layer`]s of [`Binding`]s and [`Command`]s. Bindings map keys, such as `"ctrl+p"`, `"gg"`,
//! or `"<leader>n"`, to commands by name or to inline handlers. Layers sort by priority, then newest first; a layer
//! can follow focus, require runtime data such as an input mode, or be disabled by a condition. The engine is pure
//! Rust and owns no event loop: the app passes key events to [`Keymap::handle_key`], focus to
//! [`Keymap::set_focus`], and skips its own key handling when the result says the key was consumed.
//!
//! ```
//! use opentui::input::{KeyCode, KeyEvent, Modifiers};
//! use opentui::keymap::{Binding, Command, Keymap, Layer};
//! use std::cell::Cell;
//! use std::rc::Rc;
//!
//! let keymap = Keymap::<u32>::new();
//! let saved = Rc::new(Cell::new(0));
//! let counter = saved.clone();
//! let layer = keymap.register_layer(
//!     Layer::new()
//!         .command(Command::new("file.save", move |_| counter.set(counter.get() + 1)))
//!         .binding(Binding::new("ctrl+s").cmd("file.save")),
//! );
//! let result = keymap.handle_key(&KeyEvent::new(KeyCode::Char('s'), Modifiers::CTRL));
//! assert!(result.handled);
//! assert_eq!(saved.get(), 1);
//! drop(layer);
//! assert!(!keymap.handle_key(&KeyEvent::new(KeyCode::Char('s'), Modifiers::CTRL)).handled);
//! ```
//!
//! Each registration returns a [`Disposer`]. Dropping it undoes the registration; [`Disposer::forget`] keeps the
//! registration for as long as the keymap lives.
//!
//! [`addons`] has the behaviors OpenCode's TUI installs on top: comma-separated alternatives, a timed leader key,
//! Escape and Backspace editing of a pending sequence, the base-layout fallback, and the managed textarea layer.
//! [`extras`] turns configuration into bindings and formats bindings for display.

pub mod addons;
mod engine;
pub mod extras;
mod key;
#[cfg(test)]
mod tests;

pub use engine::{
    ActiveBinding, ActiveKey, ActiveKeyOptions, CommandContext, CommandEntry, CommandQuery, Diagnostic,
    DiagnosticLevel, Disposer, ExpanderInput, Expansion, KeyContext, KeyReason, KeyResult, Keymap, RunResult,
    Visibility, WeakKeymap,
};
pub use key::{Key, KeySequencePart, Stroke};

use std::any::Any;
use std::fmt;
use std::rc::Rc;

/// Whether a layer or command is enabled: always, never, or while a closure returns true. The closure runs when
/// the keymap dispatches or answers a query, so it can read app state.
#[derive(Clone, Default)]
pub enum Condition {
    #[default]
    Always,
    Never,
    When(Rc<dyn Fn() -> bool>),
}

impl Condition {
    pub fn when(check: impl Fn() -> bool + 'static) -> Self {
        Self::When(Rc::new(check))
    }

    pub(crate) fn check(&self) -> bool {
        match self {
            Condition::Always => true,
            Condition::Never => false,
            Condition::When(check) => check(),
        }
    }
}

impl From<bool> for Condition {
    fn from(enabled: bool) -> Self {
        if enabled { Self::Always } else { Self::Never }
    }
}

impl fmt::Debug for Condition {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(match self {
            Condition::Always => "Always",
            Condition::Never => "Never",
            Condition::When(_) => "When(..)",
        })
    }
}

/// What a command or inline handler did: handled the key, or rejected it so dispatch tries the next candidate.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Outcome {
    Handled,
    Rejected,
}

/// Values a handler can return: `()` handles, `false` rejects.
pub trait IntoOutcome {
    fn into_outcome(self) -> Outcome;
}

impl IntoOutcome for () {
    fn into_outcome(self) -> Outcome {
        Outcome::Handled
    }
}

impl IntoOutcome for bool {
    fn into_outcome(self) -> Outcome {
        if self { Outcome::Handled } else { Outcome::Rejected }
    }
}

impl IntoOutcome for Outcome {
    fn into_outcome(self) -> Outcome {
        self
    }
}

/// A command or inline binding handler.
pub type Handler<T> = Rc<dyn Fn(&CommandContext<T>) -> Outcome>;

fn handler<T, R: IntoOutcome>(run: impl Fn(&CommandContext<T>) -> R + 'static) -> Handler<T> {
    Rc::new(move |context| run(context).into_outcome())
}

/// What a binding runs: a command by name, or an inline handler.
pub enum BindingCommand<T> {
    Name(String),
    Handler(Handler<T>),
}

impl<T> Clone for BindingCommand<T> {
    fn clone(&self) -> Self {
        match self {
            BindingCommand::Name(name) => BindingCommand::Name(name.clone()),
            BindingCommand::Handler(run) => BindingCommand::Handler(run.clone()),
        }
    }
}

impl<T> BindingCommand<T> {
    /// The command name, for a binding that names one.
    pub fn name(&self) -> Option<&str> {
        match self {
            BindingCommand::Name(name) => Some(name),
            BindingCommand::Handler(_) => None,
        }
    }
}

impl<T> fmt::Debug for BindingCommand<T> {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            BindingCommand::Name(name) => write!(formatter, "Name({name:?})"),
            BindingCommand::Handler(_) => formatter.write_str("Handler(..)"),
        }
    }
}

/// Whether a binding fires when its key goes down or comes up. Release bindings take one stroke.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub enum KeyEventType {
    #[default]
    Press,
    Release,
}

/// A key and what it runs.
#[derive(Debug)]
pub struct Binding<T> {
    pub key: Key,
    pub cmd: Option<BindingCommand<T>>,
    pub event: KeyEventType,
    /// Consumes the key when the binding runs, so it does not reach the focused widget. On by default.
    /// Independent of `fallthrough`, which only affects dispatch inside the keymap.
    pub prevent_default: bool,
    /// Continues to later matching bindings after this one runs. Off by default.
    pub fallthrough: bool,
    pub desc: Option<String>,
    pub group: Option<String>,
}

impl<T> Clone for Binding<T> {
    fn clone(&self) -> Self {
        Self {
            key: self.key.clone(),
            cmd: self.cmd.clone(),
            event: self.event,
            prevent_default: self.prevent_default,
            fallthrough: self.fallthrough,
            desc: self.desc.clone(),
            group: self.group.clone(),
        }
    }
}

impl<T> Binding<T> {
    pub fn new(key: impl Into<Key>) -> Self {
        Self {
            key: key.into(),
            cmd: None,
            event: KeyEventType::Press,
            prevent_default: true,
            fallthrough: false,
            desc: None,
            group: None,
        }
    }

    /// Runs the command named `name`.
    pub fn cmd(mut self, name: impl Into<String>) -> Self {
        self.cmd = Some(BindingCommand::Name(name.into()));
        self
    }

    /// Runs `run` inline; returning `false` rejects the key.
    pub fn run<R: IntoOutcome>(mut self, run: impl Fn(&CommandContext<T>) -> R + 'static) -> Self {
        self.cmd = Some(BindingCommand::Handler(handler(run)));
        self
    }

    pub fn release(mut self) -> Self {
        self.event = KeyEventType::Release;
        self
    }

    pub fn prevent_default(mut self, prevent_default: bool) -> Self {
        self.prevent_default = prevent_default;
        self
    }

    pub fn fallthrough(mut self, fallthrough: bool) -> Self {
        self.fallthrough = fallthrough;
        self
    }

    pub fn desc(mut self, desc: impl Into<String>) -> Self {
        self.desc = Some(desc.into());
        self
    }

    pub fn group(mut self, group: impl Into<String>) -> Self {
        self.group = Some(group.into());
        self
    }
}

/// A named action. Bindings refer to it by name; the first reachable command of a name wins, and a command that
/// rejects passes to the next one of the same name.
pub struct Command<T> {
    pub name: String,
    pub run: Handler<T>,
    pub title: Option<String>,
    pub desc: Option<String>,
    pub category: Option<String>,
    /// A label queries can filter on, such as `"palette"`.
    pub namespace: Option<String>,
    pub enabled: Condition,
    /// App data carried with the command, such as a palette entry.
    pub data: Option<Rc<dyn Any>>,
}

impl<T> Clone for Command<T> {
    fn clone(&self) -> Self {
        Self {
            name: self.name.clone(),
            run: self.run.clone(),
            title: self.title.clone(),
            desc: self.desc.clone(),
            category: self.category.clone(),
            namespace: self.namespace.clone(),
            enabled: self.enabled.clone(),
            data: self.data.clone(),
        }
    }
}

impl<T> Command<T> {
    pub fn new<R: IntoOutcome>(name: impl Into<String>, run: impl Fn(&CommandContext<T>) -> R + 'static) -> Self {
        Self {
            name: name.into(),
            run: handler(run),
            title: None,
            desc: None,
            category: None,
            namespace: None,
            enabled: Condition::Always,
            data: None,
        }
    }

    pub fn title(mut self, title: impl Into<String>) -> Self {
        self.title = Some(title.into());
        self
    }

    pub fn desc(mut self, desc: impl Into<String>) -> Self {
        self.desc = Some(desc.into());
        self
    }

    pub fn category(mut self, category: impl Into<String>) -> Self {
        self.category = Some(category.into());
        self
    }

    pub fn namespace(mut self, namespace: impl Into<String>) -> Self {
        self.namespace = Some(namespace.into());
        self
    }

    pub fn enabled(mut self, enabled: impl Into<Condition>) -> Self {
        self.enabled = enabled.into();
        self
    }

    pub fn data(mut self, data: impl Any) -> Self {
        self.data = Some(Rc::new(data));
        self
    }

    /// The app data, if it has type `D`.
    pub fn data_as<D: Any>(&self) -> Option<&D> {
        self.data.as_deref()?.downcast_ref()
    }
}

impl<T> fmt::Debug for Command<T> {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("Command")
            .field("name", &self.name)
            .field("title", &self.title)
            .field("desc", &self.desc)
            .field("category", &self.category)
            .field("namespace", &self.namespace)
            .field("enabled", &self.enabled)
            .finish_non_exhaustive()
    }
}

/// Which focus a targeted layer follows.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub enum TargetMode {
    /// Active while the target or one of its descendants has focus.
    #[default]
    FocusWithin,
    /// Active only while the target itself has focus.
    Focus,
}

/// A set of bindings and commands that are active together.
#[derive(Clone, Debug)]
pub struct Layer<T> {
    pub target: Option<T>,
    pub target_mode: Option<TargetMode>,
    pub priority: i32,
    pub enabled: Condition,
    /// Runtime data the layer needs: each `(name, value)` must equal [`Keymap::data`]`(name)`.
    pub requires: Vec<(String, String)>,
    pub bindings: Vec<Binding<T>>,
    pub commands: Vec<Command<T>>,
}

impl<T> Default for Layer<T> {
    fn default() -> Self {
        Self {
            target: None,
            target_mode: None,
            priority: 0,
            enabled: Condition::Always,
            requires: Vec::new(),
            bindings: Vec::new(),
            commands: Vec::new(),
        }
    }
}

impl<T> Layer<T> {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn target(mut self, target: T) -> Self {
        self.target = Some(target);
        self
    }

    pub fn target_mode(mut self, mode: TargetMode) -> Self {
        self.target_mode = Some(mode);
        self
    }

    pub fn priority(mut self, priority: i32) -> Self {
        self.priority = priority;
        self
    }

    pub fn enabled(mut self, enabled: impl Into<Condition>) -> Self {
        self.enabled = enabled.into();
        self
    }

    pub fn require(mut self, name: impl Into<String>, value: impl Into<String>) -> Self {
        self.requires.push((name.into(), value.into()));
        self
    }

    pub fn binding(mut self, binding: Binding<T>) -> Self {
        self.bindings.push(binding);
        self
    }

    pub fn bindings(mut self, bindings: impl IntoIterator<Item = Binding<T>>) -> Self {
        self.bindings.extend(bindings);
        self
    }

    pub fn command(mut self, command: Command<T>) -> Self {
        self.commands.push(command);
        self
    }

    pub fn commands(mut self, commands: impl IntoIterator<Item = Command<T>>) -> Self {
        self.commands.extend(commands);
        self
    }
}
