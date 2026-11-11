//! The keymap state, binding compilation, dispatch, and queries.
//!
//! Dispatch follows `@opentui/keymap`'s `services/dispatch.ts`. State lives behind one `RefCell`; no borrow is held
//! while a command, condition, intercept, or listener runs, so those closures can call back into the keymap.

use super::key::{self, Parsed};
use super::{Binding, BindingCommand, Command, Key, KeyEventType, KeySequencePart, Layer, Outcome, Stroke, TargetMode};
use crate::input::{KeyEvent, KeyEventKind};
use std::cell::{Cell, Ref, RefCell, RefMut};
use std::collections::{HashMap, HashSet};
use std::fmt;
use std::rc::{Rc, Weak};

/// A handle to a keymap. Clones share the same keymap.
pub struct Keymap<T>(Rc<Inner<T>>);

impl<T> Clone for Keymap<T> {
    fn clone(&self) -> Self {
        Self(self.0.clone())
    }
}

/// A keymap handle that does not keep the keymap alive, for closures the keymap itself stores.
pub struct WeakKeymap<T>(Weak<Inner<T>>);

impl<T> Clone for WeakKeymap<T> {
    fn clone(&self) -> Self {
        Self(self.0.clone())
    }
}

impl<T> WeakKeymap<T> {
    pub fn upgrade(&self) -> Option<Keymap<T>> {
        self.0.upgrade().map(Keymap)
    }
}

/// Undoes a registration when disposed or dropped. Call [`forget`](Self::forget) to keep the registration for the
/// keymap's lifetime.
#[must_use = "dropping a Disposer undoes its registration; keep it, or call forget() to keep the registration"]
pub struct Disposer(Option<Box<dyn FnOnce()>>);

impl Disposer {
    pub fn new(dispose: impl FnOnce() + 'static) -> Self {
        Self(Some(Box::new(dispose)))
    }

    pub fn noop() -> Self {
        Self(None)
    }

    /// One disposer for several, disposed in reverse order.
    pub fn all(disposers: Vec<Disposer>) -> Self {
        Self::new(move || disposers.into_iter().rev().for_each(Disposer::dispose))
    }

    pub fn dispose(self) {
        drop(self);
    }

    /// Keeps the registration until the keymap drops. Leaks the undo closure rather than drop it, because a closure
    /// such as [`all`](Self::all)'s owns disposers that would undo theirs.
    pub fn forget(mut self) {
        std::mem::forget(self.0.take());
    }
}

impl Drop for Disposer {
    fn drop(&mut self) {
        if let Some(dispose) = self.0.take() {
            dispose();
        }
    }
}

impl fmt::Debug for Disposer {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str("Disposer")
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum DiagnosticLevel {
    Warning,
    Error,
}

/// A problem the keymap reported instead of failing, such as a binding it could not parse.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Diagnostic {
    pub level: DiagnosticLevel,
    pub code: String,
    pub message: String,
}

/// What a binding expander sees: a binding's key text and the displays an earlier expander chose.
pub struct ExpanderInput<'a> {
    pub input: &'a str,
    pub displays: Option<&'a [String]>,
}

/// One key an expander turns a binding's key into, with an optional display per stroke.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Expansion {
    pub key: String,
    pub displays: Option<Vec<String>>,
}

/// Why a key ended where it did.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum KeyReason {
    /// A key intercept stopped propagation.
    InterceptConsumed,
    BindingHandled,
    BindingRejected,
    NoMatch,
    /// The key started or continued a sequence.
    SequencePending,
    /// The key did not continue the pending sequence, which is cleared. The key is not consumed.
    SequenceMiss,
}

/// The result of [`Keymap::handle_key`]. Skip the app's own handling of the key, such as the focused widget's,
/// when `stop_propagation` is set.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct KeyResult {
    pub handled: bool,
    pub reason: KeyReason,
    pub prevent_default: bool,
    pub stop_propagation: bool,
}

/// What a key intercept sees.
pub struct KeyContext<T> {
    pub keymap: Keymap<T>,
    pub event: KeyEvent,
    pub stroke: Stroke,
    prevent_default: Cell<bool>,
    stop_propagation: Cell<bool>,
    /// The active view built for this key, until a command or handler runs and may change what a new one shows.
    view: Cell<Option<Rc<ActiveView<T>>>>,
}

impl<T> KeyContext<T> {
    pub fn prevent_default(&self) {
        self.prevent_default.set(true);
    }

    /// Ends dispatch: later intercepts and bindings do not see the key.
    pub fn stop_propagation(&self) {
        self.stop_propagation.set(true);
    }

    /// Prevents the default and stops propagation.
    pub fn consume(&self) {
        self.prevent_default();
        self.stop_propagation();
    }
}

/// What a command or inline handler sees.
pub struct CommandContext<T> {
    pub keymap: Keymap<T>,
    /// The key that ran it, or `None` for [`Keymap::dispatch_command`] and [`Keymap::run_command`].
    pub event: Option<KeyEvent>,
    pub focused: Option<T>,
    /// The target of the layer that registered the command, or of the binding's layer.
    pub target: Option<T>,
    /// The command name as invoked.
    pub input: String,
    /// The command that runs, when the binding named one.
    pub command: Option<Rc<Command<T>>>,
}

/// The result of running a command by name.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum RunResult {
    Ok,
    NotFound,
    /// Registered only in layers that do not follow the current focus.
    Inactive,
    /// Registered, but its layer or the command is disabled.
    Disabled,
    Rejected,
    InvalidArgs,
}

/// Which commands and bindings a query covers.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub enum Visibility {
    /// The first enabled command of each name in the active layers.
    #[default]
    Reachable,
    /// Every enabled command in the active layers.
    Active,
    /// Every registered command.
    Registered,
}

/// A predicate a command query applies last.
pub type CommandFilter<T> = Rc<dyn Fn(&Command<T>) -> bool>;

/// A command query; the default lists the reachable commands.
pub struct CommandQuery<T> {
    pub visibility: Visibility,
    /// Commands whose namespace is one of these.
    pub namespace: Option<Vec<String>>,
    /// Text the fields in `search_in` must contain, ignoring case.
    pub search: Option<String>,
    /// `name`, `title`, `desc`, `category`, or `namespace`; `name` when empty.
    pub search_in: Vec<String>,
    pub names: Option<Vec<String>>,
    pub filter: Option<CommandFilter<T>>,
    pub limit: Option<usize>,
}

impl<T> Default for CommandQuery<T> {
    fn default() -> Self {
        Self {
            visibility: Visibility::Reachable,
            namespace: None,
            search: None,
            search_in: Vec::new(),
            names: None,
            filter: None,
            limit: None,
        }
    }
}

impl<T> CommandQuery<T> {
    pub fn visibility(visibility: Visibility) -> Self {
        Self { visibility, ..Self::default() }
    }
}

/// A binding as queries report it.
pub struct ActiveBinding<T> {
    pub sequence: Vec<KeySequencePart>,
    pub command: Option<BindingCommand<T>>,
    /// The command the binding's name resolves to.
    pub command_info: Option<Rc<Command<T>>>,
    pub desc: Option<String>,
    pub group: Option<String>,
    pub event: KeyEventType,
    pub prevent_default: bool,
    pub fallthrough: bool,
}

impl<T> Clone for ActiveBinding<T> {
    fn clone(&self) -> Self {
        Self {
            sequence: self.sequence.clone(),
            command: self.command.clone(),
            command_info: self.command_info.clone(),
            desc: self.desc.clone(),
            group: self.group.clone(),
            event: self.event,
            prevent_default: self.prevent_default,
            fallthrough: self.fallthrough,
        }
    }
}

/// A command and the bindings that run it.
pub struct CommandEntry<T> {
    pub command: Rc<Command<T>>,
    pub bindings: Vec<ActiveBinding<T>>,
}

#[derive(Clone, Copy, Debug, Default)]
pub struct ActiveKeyOptions {
    pub include_bindings: bool,
    /// Fills `desc`, `group`, and `command_info`.
    pub include_metadata: bool,
}

/// A key that does something now: runs a command, or continues a sequence.
pub struct ActiveKey<T> {
    pub stroke: Stroke,
    pub display: String,
    pub token: Option<String>,
    pub continues: bool,
    pub command: Option<BindingCommand<T>>,
    pub bindings: Option<Vec<ActiveBinding<T>>>,
    /// The first binding's metadata.
    pub desc: Option<String>,
    pub group: Option<String>,
    /// The command the key runs.
    pub command_info: Option<Rc<Command<T>>>,
}

struct Inner<T> {
    state: RefCell<State<T>>,
    batch: Cell<u32>,
    dirty: Cell<bool>,
}

type Expander = Rc<dyn Fn(&ExpanderInput) -> Result<Option<Vec<Expansion>>, String>>;
type Resolver = Rc<dyn Fn(&KeyEvent) -> Option<Vec<Stroke>>>;
type Listener<A> = Rc<dyn Fn(A)>;
type KeyListener<T> = Rc<dyn Fn(&KeyContext<T>)>;
type PendingListener = Rc<dyn Fn(&[KeySequencePart])>;
type DiagnosticListener = Rc<dyn Fn(&Diagnostic)>;

struct Intercept<T> {
    id: u64,
    priority: i32,
    release: bool,
    listener: KeyListener<T>,
}

struct State<T> {
    /// In registration order.
    layers: Vec<Rc<LayerState<T>>>,
    /// By priority, then newest first.
    sorted: Vec<Rc<LayerState<T>>>,
    next_id: u64,
    tokens: HashMap<String, (u64, Stroke)>,
    data: HashMap<String, String>,
    focus: Vec<T>,
    pending: Option<Vec<Capture<T>>>,
    expanders: Vec<(u64, Expander)>,
    resolvers: Vec<(u64, Resolver)>,
    intercepts: Vec<Intercept<T>>,
    state_listeners: Vec<(u64, Listener<()>)>,
    pending_listeners: Vec<(u64, PendingListener)>,
    diagnostic_listeners: Vec<(u64, DiagnosticListener)>,
    warned: HashSet<String>,
    revision: u64,
}

struct LayerState<T> {
    order: u64,
    source: Layer<T>,
    commands: Vec<Rc<Command<T>>>,
    bindings: Vec<Rc<BindingState<T>>>,
    has_token_bindings: bool,
}

struct BindingState<T> {
    sequence: Vec<KeySequencePart>,
    command: Option<BindingCommand<T>>,
    event: KeyEventType,
    prevent_default: bool,
    fallthrough: bool,
    desc: Option<String>,
    group: Option<String>,
}

/// A binding a pending sequence has matched up to `index`.
struct Capture<T> {
    layer: Rc<LayerState<T>>,
    binding: Rc<BindingState<T>>,
    index: usize,
}

impl<T> Clone for Capture<T> {
    fn clone(&self) -> Self {
        Self { layer: self.layer.clone(), binding: self.binding.clone(), index: self.index }
    }
}

impl<T> Capture<T> {
    /// The parts matched so far.
    fn parts(&self) -> &[KeySequencePart] {
        &self.binding.sequence[..=self.index]
    }

    fn continues(&self) -> bool {
        self.index + 1 < self.binding.sequence.len()
    }

    fn exact(&self) -> bool {
        self.index + 1 == self.binding.sequence.len()
    }

    fn same_parts(&self, other: &Capture<T>) -> bool {
        self.index == other.index
            && self.parts().iter().zip(other.parts()).all(|(left, right)| left.stroke == right.stroke)
    }

    /// Where the capture's last stroke appears among the event's match keys; earlier is better.
    fn priority(&self, keys: &[Stroke]) -> usize {
        let last = &self.binding.sequence[self.index].stroke;
        keys.iter().position(|key| key == last).unwrap_or(keys.len())
    }
}

struct Entry<T> {
    layer: Rc<LayerState<T>>,
    command: Rc<Command<T>>,
}

impl<T> Clone for Entry<T> {
    fn clone(&self) -> Self {
        Self { layer: self.layer.clone(), command: self.command.clone() }
    }
}

/// The active layers and their enabled commands.
struct ActiveView<T> {
    layers: Vec<Rc<LayerState<T>>>,
    entries: Vec<Entry<T>>,
    /// The index of the first entry of each name, sorted by name, so lookups borrow names instead of copying them.
    by_name: Vec<usize>,
}

impl<T> ActiveView<T> {
    fn reachable(&self, name: &str) -> Option<&Entry<T>> {
        let found = self.by_name.binary_search_by(|&index| self.entries[index].command.name.as_str().cmp(name));
        found.ok().map(|found| &self.entries[self.by_name[found]])
    }

    /// The first entry of each name, in layer order.
    fn reachable_entries(&self) -> Vec<Entry<T>> {
        let mut first = self.by_name.clone();
        first.sort_unstable();
        first.into_iter().map(|index| self.entries[index].clone()).collect()
    }

    fn chain<'a>(&'a self, name: &'a str) -> impl Iterator<Item = &'a Entry<T>> {
        self.entries.iter().filter(move |entry| entry.command.name == name)
    }

    fn visible(&self, binding: &BindingState<T>) -> bool {
        match &binding.command {
            Some(BindingCommand::Name(name)) => self.reachable(name).is_some(),
            _ => true,
        }
    }
}

#[derive(Clone, Copy)]
struct Dispatched {
    handled: bool,
    reason: KeyReason,
}

const NO_MATCH: Dispatched = Dispatched { handled: false, reason: KeyReason::NoMatch };

fn prefer(current: Dispatched, next: Dispatched) -> Dispatched {
    if next.handled || current.reason == KeyReason::NoMatch { next } else { current }
}

struct Ran {
    handled: bool,
    stop: bool,
    outcome: Dispatched,
}

impl<T: Clone + PartialEq + 'static> Default for Keymap<T> {
    fn default() -> Self {
        Self::new()
    }
}

impl<T: Clone + PartialEq + 'static> Keymap<T> {
    /// A keymap with the default binding syntax and key matching, as `createDefaultOpenTuiKeymap` makes.
    pub fn new() -> Self {
        Self(Rc::new(Inner {
            state: RefCell::new(State {
                layers: Vec::new(),
                sorted: Vec::new(),
                next_id: 0,
                tokens: HashMap::new(),
                data: HashMap::new(),
                focus: Vec::new(),
                pending: None,
                expanders: Vec::new(),
                resolvers: Vec::new(),
                intercepts: Vec::new(),
                state_listeners: Vec::new(),
                pending_listeners: Vec::new(),
                diagnostic_listeners: Vec::new(),
                warned: HashSet::new(),
                revision: 0,
            }),
            batch: Cell::new(0),
            dirty: Cell::new(false),
        }))
    }

    pub fn downgrade(&self) -> WeakKeymap<T> {
        WeakKeymap(Rc::downgrade(&self.0))
    }

    fn state(&self) -> Ref<'_, State<T>> {
        self.0.state.borrow()
    }

    fn state_mut(&self) -> RefMut<'_, State<T>> {
        self.0.state.borrow_mut()
    }

    fn next_id(&self) -> u64 {
        let mut state = self.state_mut();
        state.next_id += 1;
        state.next_id
    }

    /// Runs `run` as one state change: `on_state` listeners run once, after it.
    fn batch<R>(&self, run: impl FnOnce() -> R) -> R {
        self.0.batch.set(self.0.batch.get() + 1);
        let result = run();
        let depth = self.0.batch.get() - 1;
        self.0.batch.set(depth);
        if depth == 0 && self.0.dirty.replace(false) {
            let listeners: Vec<_> = self.state().state_listeners.iter().map(|(_, listener)| listener.clone()).collect();
            listeners.iter().for_each(|listener| listener(()));
        }
        result
    }

    fn changed(&self) {
        self.state_mut().revision += 1;
        self.0.dirty.set(true);
    }

    /// Counts state changes: anything that can change what queries return.
    pub fn revision(&self) -> u64 {
        self.state().revision
    }

    fn report(&self, level: DiagnosticLevel, code: &str, message: String) {
        let diagnostic = Diagnostic { level, code: code.to_owned(), message };
        let listeners: Vec<_> =
            self.state().diagnostic_listeners.iter().map(|(_, listener)| listener.clone()).collect();
        listeners.iter().for_each(|listener| listener(&diagnostic));
    }

    fn error(&self, code: &str, message: impl Into<String>) {
        self.report(DiagnosticLevel::Error, code, message.into());
    }

    fn warn_once(&self, key: String, code: &str, message: String) {
        if self.state_mut().warned.insert(key) {
            self.report(DiagnosticLevel::Warning, code, message);
        }
    }

    // Registration.

    /// Registers a layer. A layer with no bindings and no commands is ignored.
    pub fn register_layer(&self, layer: Layer<T>) -> Disposer {
        self.batch(|| {
            if let (Some(mode), None) = (layer.target_mode, &layer.target) {
                let mode = if mode == TargetMode::Focus { "focus" } else { "focus-within" };
                self.error("register-layer-failed", format!("Keymap targetMode \"{mode}\" requires a target"));
                return Disposer::noop();
            }
            let commands = self.compile_commands(&layer.commands);
            let (bindings, has_token_bindings) = self.compile_bindings(&layer.bindings);
            if bindings.is_empty() && !has_token_bindings && commands.is_empty() {
                return Disposer::noop();
            }
            let order = self.next_id();
            let registered = Rc::new(LayerState { order, source: layer, commands, bindings, has_token_bindings });
            {
                let mut state = self.state_mut();
                state.layers.push(registered.clone());
                state.sorted.push(registered.clone());
                sort_layers(&mut state.sorted);
            }
            if !registered.commands.is_empty() {
                self.ensure_valid_pending();
            }
            self.changed();
            let keymap = self.downgrade();
            Disposer::new(move || {
                if let Some(keymap) = keymap.upgrade() {
                    keymap.unregister_layer(order);
                }
            })
        })
    }

    fn unregister_layer(&self, order: u64) {
        self.batch(|| {
            // The layer drops after the borrow ends: its handlers may own disposers that unregister in turn.
            let removed = {
                let mut state = self.state_mut();
                state.sorted.retain(|layer| layer.order != order);
                take(&mut state.layers, |layer| layer.order == order)
            };
            if removed.is_some() {
                self.ensure_valid_pending();
                self.changed();
            }
        })
    }

    fn compile_commands(&self, commands: &[Command<T>]) -> Vec<Rc<Command<T>>> {
        let mut compiled: Vec<Rc<Command<T>>> = Vec::new();
        for command in commands {
            match normalize_command(command) {
                Ok(command) if compiled.iter().any(|existing| existing.name == command.name) => self.error(
                    "duplicate-command",
                    format!("Duplicate keymap command \"{}\" in the same layer", command.name),
                ),
                Ok(command) => compiled.push(Rc::new(command)),
                Err(message) => self.error("register-command-failed", message),
            }
        }
        compiled
    }

    fn compile_bindings(&self, bindings: &[Binding<T>]) -> (Vec<Rc<BindingState<T>>>, bool) {
        let (tokens, expanders) = {
            let state = self.state();
            let tokens: HashMap<String, Stroke> =
                state.tokens.iter().map(|(name, (_, stroke))| (name.clone(), stroke.clone())).collect();
            (tokens, state.expanders.iter().map(|(_, expander)| expander.clone()).collect::<Vec<_>>())
        };
        let mut compiled: Vec<Rc<BindingState<T>>> = Vec::new();
        let mut has_token_bindings = false;
        for binding in bindings {
            let expansions = match &binding.key {
                Key::Stroke(stroke) => vec![(Key::Stroke(stroke.clone()), None)],
                Key::Text(text) => match expand(text, &expanders) {
                    Ok(expansions) => expansions,
                    Err(message) => {
                        self.error("binding-expand-error", message);
                        continue;
                    }
                },
            };
            for (key, displays) in expansions {
                let parsed = match &key {
                    Key::Stroke(stroke) => stroke.normalized().map(|stroke| Parsed {
                        parts: vec![KeySequencePart::from_stroke(stroke)],
                        used_tokens: false,
                        unknown_tokens: Vec::new(),
                    }),
                    Key::Text(text) => key::parse_sequence(text, &tokens),
                };
                let parsed = match parsed.and_then(|parsed| apply_displays(parsed, displays, &key)) {
                    Ok(parsed) => parsed,
                    Err(message) => {
                        self.error("binding-parse-error", message);
                        continue;
                    }
                };
                has_token_bindings |= parsed.used_tokens;
                for token in &parsed.unknown_tokens {
                    self.warn_once(
                        format!("token:{token}"),
                        "unknown-token",
                        format!(
                            "[Keymap] Unknown token \"{token}\" in key sequence \"{key}\"; binding was skipped until \
                             the token is registered"
                        ),
                    );
                }
                if !parsed.unknown_tokens.is_empty() {
                    continue;
                }
                match compile_binding(binding, parsed.parts, &compiled) {
                    Ok(Some(state)) => compiled.push(Rc::new(state)),
                    Ok(None) => {}
                    Err(message) => self.error("binding-compile-error", message),
                }
            }
        }
        (compiled, has_token_bindings)
    }

    /// Registers a token that bindings name as `<name>`, such as `leader`. Layers that used the name before it was
    /// registered compile again.
    pub fn register_token(&self, name: &str, key: impl Into<Key>) -> Disposer {
        let key = key.into();
        self.batch(|| {
            let name = match key::normalize_token(name) {
                Ok(name) => name,
                Err(message) => {
                    self.error("token-name-normalize-error", message);
                    return Disposer::noop();
                }
            };
            if self.state().tokens.contains_key(&name) {
                self.error("duplicate-token", format!("Keymap token \"{name}\" is already registered"));
                return Disposer::noop();
            }
            let part = match key::parse_single(&key, &self.tokens()) {
                Ok(part) => part,
                Err(message) => {
                    self.error("token-parse-error", message);
                    return Disposer::noop();
                }
            };
            let id = self.next_id();
            self.state_mut().tokens.insert(name.clone(), (id, part.stroke));
            self.recompile_token_layers();
            let keymap = self.downgrade();
            Disposer::new(move || {
                let Some(keymap) = keymap.upgrade() else { return };
                keymap.batch(|| {
                    let removed = {
                        let mut state = keymap.state_mut();
                        let current = state.tokens.get(&name).is_some_and(|(current, _)| *current == id);
                        current && state.tokens.remove(&name).is_some()
                    };
                    if removed {
                        keymap.recompile_token_layers();
                    }
                })
            })
        })
    }

    fn tokens(&self) -> HashMap<String, Stroke> {
        self.state().tokens.iter().map(|(name, (_, stroke))| (name.clone(), stroke.clone())).collect()
    }

    fn recompile_token_layers(&self) {
        let layers: Vec<_> = self.state().layers.iter().filter(|layer| layer.has_token_bindings).cloned().collect();
        if layers.is_empty() {
            return;
        }
        for layer in layers {
            let (bindings, has_token_bindings) = self.compile_bindings(&layer.source.bindings);
            let next = Rc::new(LayerState {
                order: layer.order,
                source: layer.source.clone(),
                commands: layer.commands.clone(),
                bindings,
                has_token_bindings,
            });
            let mut state = self.state_mut();
            let state = &mut *state;
            for list in [&mut state.layers, &mut state.sorted] {
                if let Some(slot) = list.iter_mut().find(|slot| slot.order == layer.order) {
                    *slot = next.clone();
                }
            }
        }
        self.set_pending(None);
        self.changed();
    }

    /// Adds a binding expander, which turns a binding's key text into one or more keys. It applies to layers
    /// registered after it.
    pub fn append_binding_expander(
        &self,
        expander: impl Fn(&ExpanderInput) -> Result<Option<Vec<Expansion>>, String> + 'static,
    ) -> Disposer {
        let id = self.next_id();
        self.state_mut().expanders.push((id, Rc::new(expander)));
        self.remove_on_dispose(move |state| take(&mut state.expanders, |(current, _)| *current == id))
    }

    /// Adds strokes a key event also matches, after its own stroke.
    pub fn append_event_match_resolver(
        &self,
        resolver: impl Fn(&KeyEvent) -> Option<Vec<Stroke>> + 'static,
    ) -> Disposer {
        let id = self.next_id();
        self.state_mut().resolvers.push((id, Rc::new(resolver)));
        self.remove_on_dispose(move |state| take(&mut state.resolvers, |(current, _)| *current == id))
    }

    /// Runs `listener` for each key before bindings, highest priority first; `release` selects key releases
    /// instead of presses. A listener that stops propagation ends dispatch.
    pub fn intercept_key(&self, priority: i32, release: bool, listener: impl Fn(&KeyContext<T>) + 'static) -> Disposer {
        let id = self.next_id();
        {
            let mut state = self.state_mut();
            state.intercepts.push(Intercept { id, priority, release, listener: Rc::new(listener) });
            state.intercepts.sort_by(|left, right| right.priority.cmp(&left.priority).then(left.id.cmp(&right.id)));
        }
        self.remove_on_dispose(move |state| take(&mut state.intercepts, |intercept| intercept.id == id))
    }

    /// Runs `listener` after each change to what queries return, once per batch of changes.
    pub fn on_state(&self, listener: impl Fn() + 'static) -> Disposer {
        let id = self.next_id();
        self.state_mut().state_listeners.push((id, Rc::new(move |()| listener())));
        self.remove_on_dispose(move |state| take(&mut state.state_listeners, |(current, _)| *current == id))
    }

    /// Runs `listener` with the pending sequence each time it changes, including when it clears.
    pub fn on_pending_sequence(&self, listener: impl Fn(&[KeySequencePart]) + 'static) -> Disposer {
        let id = self.next_id();
        self.state_mut().pending_listeners.push((id, Rc::new(listener)));
        self.remove_on_dispose(move |state| take(&mut state.pending_listeners, |(current, _)| *current == id))
    }

    /// Runs `listener` for each warning and error, such as a binding that does not parse.
    pub fn on_diagnostic(&self, listener: impl Fn(&Diagnostic) + 'static) -> Disposer {
        let id = self.next_id();
        self.state_mut().diagnostic_listeners.push((id, Rc::new(listener)));
        self.remove_on_dispose(move |state| take(&mut state.diagnostic_listeners, |(current, _)| *current == id))
    }

    /// `remove` returns what it removed, which drops after the borrow ends: a listener may own disposers.
    fn remove_on_dispose<R>(&self, remove: impl FnOnce(&mut State<T>) -> R + 'static) -> Disposer {
        let keymap = self.downgrade();
        Disposer::new(move || {
            if let Some(keymap) = keymap.upgrade() {
                let removed = remove(&mut keymap.state_mut());
                drop(removed);
            }
        })
    }

    // Runtime state.

    /// Sets the focused target, followed by its ancestors; empty when nothing has focus. A change of the focused
    /// target clears a pending sequence.
    pub fn set_focus(&self, path: Vec<T>) {
        self.batch(|| {
            let moved = {
                let mut state = self.state_mut();
                if state.focus == path {
                    return;
                }
                let moved = state.focus.first() != path.first();
                state.focus = path;
                moved
            };
            if moved {
                self.set_pending(None);
            }
            self.changed();
        })
    }

    pub fn focused(&self) -> Option<T> {
        self.state().focus.first().cloned()
    }

    pub fn data(&self, name: &str) -> Option<String> {
        self.state().data.get(name).cloned()
    }

    /// Sets runtime data that layers can require, such as the input mode.
    pub fn set_data(&self, name: &str, value: impl Into<String>) {
        let value = value.into();
        self.batch(|| {
            if self.state().data.get(name) == Some(&value) {
                return;
            }
            self.state_mut().data.insert(name.to_owned(), value);
            self.ensure_valid_pending();
            self.changed();
        })
    }

    pub fn clear_data(&self, name: &str) {
        self.batch(|| {
            if self.state_mut().data.remove(name).is_none() {
                return;
            }
            self.ensure_valid_pending();
            self.changed();
        })
    }

    // Conditions and views.

    fn layer_active(layer: &LayerState<T>, focus: &[T]) -> bool {
        match &layer.source.target {
            None => true,
            Some(target) if layer.source.target_mode == Some(TargetMode::Focus) => focus.first() == Some(target),
            Some(target) => focus.contains(target),
        }
    }

    fn active_layers(&self) -> Vec<Rc<LayerState<T>>> {
        let state = self.state();
        state.sorted.iter().filter(|layer| Self::layer_active(layer, &state.focus)).cloned().collect()
    }

    fn layer_enabled(&self, layer: &LayerState<T>) -> bool {
        let required = {
            let state = self.state();
            layer.source.requires.iter().all(|(name, value)| state.data.get(name) == Some(value))
        };
        required && layer.source.enabled.check()
    }

    fn active_view(&self) -> Rc<ActiveView<T>> {
        let layers = self.active_layers();
        let mut entries = Vec::with_capacity(layers.iter().map(|layer| layer.commands.len()).sum());
        for layer in &layers {
            if layer.commands.is_empty() || !self.layer_enabled(layer) {
                continue;
            }
            for command in layer.commands.iter().filter(|command| command.enabled.check()) {
                entries.push(Entry { layer: layer.clone(), command: command.clone() });
            }
        }
        // Ties sort by index, so the first entry of each name leads its run and survives `dedup_by`.
        let mut by_name: Vec<usize> = (0..entries.len()).collect();
        by_name.sort_unstable_by_key(|&index| (&entries[index].command.name, index));
        by_name.dedup_by(|later, first| entries[*later].command.name == entries[*first].command.name);
        Rc::new(ActiveView { layers, entries, by_name })
    }

    /// The view `context` holds for its key, or a new one that it then holds.
    fn key_view(&self, context: &KeyContext<T>) -> Rc<ActiveView<T>> {
        let view = context.view.take().unwrap_or_else(|| self.active_view());
        context.view.set(Some(view.clone()));
        view
    }

    // Dispatch.

    /// Dispatches a key event: key intercepts, then the pending sequence or the active layers.
    pub fn handle_key(&self, event: &KeyEvent) -> KeyResult {
        self.batch(|| {
            let release = event.kind == KeyEventKind::Release;
            let context = KeyContext {
                keymap: self.clone(),
                event: *event,
                stroke: Stroke::from_event(event),
                prevent_default: Cell::new(false),
                stop_propagation: Cell::new(false),
                view: Cell::new(None),
            };
            let intercepts: Vec<_> = self
                .state()
                .intercepts
                .iter()
                .filter(|intercept| intercept.release == release)
                .map(|intercept| intercept.listener.clone())
                .collect();
            let mut outcome = None;
            for intercept in intercepts {
                intercept(&context);
                if context.stop_propagation.get() {
                    outcome = Some(Dispatched { handled: true, reason: KeyReason::InterceptConsumed });
                    break;
                }
            }
            let outcome = outcome.unwrap_or_else(|| {
                if release { self.dispatch_release(&context) } else { self.dispatch_press(&context) }
            });
            KeyResult {
                handled: outcome.handled,
                reason: outcome.reason,
                prevent_default: context.prevent_default.get(),
                stop_propagation: context.stop_propagation.get(),
            }
        })
    }

    fn match_keys(&self, event: &KeyEvent) -> Vec<Stroke> {
        let resolvers: Vec<_> = self.state().resolvers.iter().map(|(_, resolver)| resolver.clone()).collect();
        let mut keys = vec![Stroke::from_event(event)];
        for stroke in resolvers.iter().filter_map(|resolver| resolver(event)).flatten() {
            if !keys.contains(&stroke) {
                keys.push(stroke);
            }
        }
        keys
    }

    fn dispatch_press(&self, context: &KeyContext<T>) -> Dispatched {
        let pending = self.ensure_valid_pending();
        let keys = self.match_keys(&context.event);
        if let Some(pending) = pending {
            return self.dispatch_pending(&pending, &keys, context);
        }
        let layers = self.active_layers();
        let mut outcome = NO_MATCH;
        for key in &keys {
            let result = self.dispatch_from_root(&layers, std::slice::from_ref(key), context);
            outcome = prefer(outcome, result);
            if result.handled {
                return outcome;
            }
        }
        outcome
    }

    fn root_captures(&self, layer: &Rc<LayerState<T>>, keys: &[Stroke], view: &ActiveView<T>) -> Vec<Capture<T>> {
        let mut best = usize::MAX;
        let mut captures = Vec::new();
        for binding in &layer.bindings {
            if binding.event != KeyEventType::Press {
                continue;
            }
            let first = &binding.sequence[0];
            let Some(priority) = keys.iter().position(|key| *key == first.stroke) else { continue };
            if priority < best {
                best = priority;
                captures.clear();
            }
            if priority == best {
                captures.push(Capture { layer: layer.clone(), binding: binding.clone(), index: 0 });
            }
        }
        if captures.iter().any(|capture| view.visible(&capture.binding)) { captures } else { Vec::new() }
    }

    fn dispatch_from_root(&self, layers: &[Rc<LayerState<T>>], keys: &[Stroke], context: &KeyContext<T>) -> Dispatched {
        let view = self.key_view(context);
        let mut outcome = NO_MATCH;
        for (index, layer) in layers.iter().enumerate() {
            if !self.layer_enabled(layer) {
                continue;
            }
            let captures = self.root_captures(layer, keys, &view);
            if captures.is_empty() {
                continue;
            }
            if captures.iter().any(Capture::continues) {
                // A prefix wins over exact bindings, and collects the continuations of every lower layer too.
                let continuations = layers[index..]
                    .iter()
                    .filter(|layer| self.layer_enabled(layer))
                    .flat_map(|layer| self.root_captures(layer, keys, &view))
                    .filter(Capture::continues)
                    .collect();
                return self.hold(continuations, context);
            }
            let exact: Vec<_> = captures.into_iter().filter(Capture::exact).collect();
            let ran = self.run_captures(layer, &exact, context);
            outcome = prefer(outcome, ran.outcome);
            if ran.handled && ran.stop {
                return outcome;
            }
        }
        outcome
    }

    fn hold(&self, captures: Vec<Capture<T>>, context: &KeyContext<T>) -> Dispatched {
        self.set_pending(Some(captures));
        context.consume();
        Dispatched { handled: true, reason: KeyReason::SequencePending }
    }

    fn dispatch_pending(&self, pending: &[Capture<T>], keys: &[Stroke], context: &KeyContext<T>) -> Dispatched {
        let view = self.key_view(context);
        let advanced: Vec<Capture<T>> = pending
            .iter()
            .filter_map(|capture| {
                let next = capture.binding.sequence.get(capture.index + 1)?;
                keys.contains(&next.stroke).then(|| Capture { index: capture.index + 1, ..capture.clone() })
            })
            .collect();
        let best = advanced.iter().map(|capture| capture.priority(keys)).min();
        let prioritized: Vec<_> = advanced.into_iter().filter(|capture| Some(capture.priority(keys)) == best).collect();
        if !prioritized.iter().any(|capture| view.visible(&capture.binding)) {
            self.set_pending(None);
            return Dispatched { handled: false, reason: KeyReason::SequenceMiss };
        }
        self.dispatch_pending_from(&prioritized, context)
    }

    fn dispatch_pending_from(&self, captures: &[Capture<T>], context: &KeyContext<T>) -> Dispatched {
        let mut handled_exact = false;
        let mut outcome = NO_MATCH;
        let mut processed = vec![false; captures.len()];
        for (index, capture) in captures.iter().enumerate() {
            if processed[index] {
                continue;
            }
            let continuations: Vec<_> = captures[index..]
                .iter()
                .filter(|candidate| candidate.continues() && candidate.same_parts(capture))
                .cloned()
                .collect();
            if !continuations.is_empty() {
                if handled_exact {
                    continue;
                }
                return self.hold(continuations, context);
            }
            if !capture.exact() {
                continue;
            }
            let mut exact = Vec::new();
            for (other, candidate) in captures.iter().enumerate() {
                if Rc::ptr_eq(&candidate.layer, &capture.layer) && candidate.exact() && candidate.same_parts(capture) {
                    processed[other] = true;
                    exact.push(candidate.clone());
                }
            }
            let ran = self.run_captures(&capture.layer, &exact, context);
            outcome = prefer(outcome, ran.outcome);
            if !ran.handled {
                continue;
            }
            handled_exact = true;
            if ran.stop {
                break;
            }
        }
        self.set_pending(None);
        outcome
    }

    fn dispatch_release(&self, context: &KeyContext<T>) -> Dispatched {
        let layers = self.active_layers();
        let mut outcome = NO_MATCH;
        for key in self.match_keys(&context.event) {
            for layer in &layers {
                if layer.bindings.is_empty() || !self.layer_enabled(layer) {
                    continue;
                }
                let mut ran = Ran { handled: false, stop: false, outcome: NO_MATCH };
                for binding in &layer.bindings {
                    if binding.event != KeyEventType::Release || binding.sequence[0].stroke != key {
                        continue;
                    }
                    let handled = self.run_binding(layer, binding, Some(context));
                    ran.outcome = prefer(ran.outcome, binding_outcome(handled));
                    if handled {
                        ran.handled = true;
                        if !binding.fallthrough {
                            ran.stop = true;
                            break;
                        }
                    }
                }
                outcome = prefer(outcome, ran.outcome);
                if ran.handled && ran.stop {
                    return outcome;
                }
            }
        }
        outcome
    }

    fn run_captures(&self, layer: &LayerState<T>, captures: &[Capture<T>], context: &KeyContext<T>) -> Ran {
        let mut ran = Ran { handled: false, stop: false, outcome: NO_MATCH };
        for capture in captures {
            let handled = self.run_binding(layer, &capture.binding, Some(context));
            ran.outcome = prefer(ran.outcome, binding_outcome(handled));
            if !handled {
                continue;
            }
            ran.handled = true;
            if !capture.binding.fallthrough {
                ran.stop = true;
                return ran;
            }
        }
        ran
    }

    /// Takes the key's view: the binding may run code that changes what a new view shows.
    fn run_binding(&self, layer: &LayerState<T>, binding: &BindingState<T>, context: Option<&KeyContext<T>>) -> bool {
        let view = context.and_then(|context| context.view.take());
        let focused = self.focused();
        let event = context.map(|context| context.event);
        let handled = match &binding.command {
            None => false,
            Some(BindingCommand::Handler(run)) => {
                let invocation = CommandContext {
                    keymap: self.clone(),
                    event,
                    focused,
                    target: layer.source.target.clone(),
                    input: "<function>".to_owned(),
                    command: None,
                };
                run(&invocation) == Outcome::Handled
            }
            Some(BindingCommand::Name(name)) => view.unwrap_or_else(|| self.active_view()).chain(name).any(|entry| {
                let invocation = CommandContext {
                    keymap: self.clone(),
                    event,
                    focused: focused.clone(),
                    target: entry.layer.source.target.clone().or_else(|| layer.source.target.clone()),
                    input: name.clone(),
                    command: Some(entry.command.clone()),
                };
                (entry.command.run)(&invocation) == Outcome::Handled
            }),
        };
        if handled && binding.prevent_default {
            context.inspect(|context| context.consume());
        }
        handled
    }

    // Pending sequence.

    fn ensure_valid_pending(&self) -> Option<Vec<Capture<T>>> {
        let pending = self.state().pending.clone()?;
        let view = self.active_view();
        let kept: Vec<_> = pending
            .iter()
            .filter(|capture| {
                let registered = {
                    let state = self.state();
                    state.layers.iter().any(|layer| Rc::ptr_eq(layer, &capture.layer))
                        && Self::layer_active(&capture.layer, &state.focus)
                };
                registered
                    && self.layer_enabled(&capture.layer)
                    && view.visible(&capture.binding)
                    && capture.continues()
            })
            .cloned()
            .collect();
        if kept.is_empty() {
            self.set_pending(None);
            return None;
        }
        if kept.len() != pending.len() {
            self.set_pending(Some(kept.clone()));
        }
        Some(kept)
    }

    fn set_pending(&self, next: Option<Vec<Capture<T>>>) {
        let parts = {
            let mut state = self.state_mut();
            if same_pending(state.pending.as_deref(), next.as_deref()) {
                return;
            }
            state.pending = next;
            state.pending.as_deref().map(sequence_parts).unwrap_or_default()
        };
        let listeners: Vec<_> = self.state().pending_listeners.iter().map(|(_, listener)| listener.clone()).collect();
        listeners.iter().for_each(|listener| listener(&parts));
        self.changed();
    }

    /// The strokes of the sequence in progress, empty when none is.
    pub fn pending_sequence(&self) -> Vec<KeySequencePart> {
        self.batch(|| self.ensure_valid_pending().as_deref().map(sequence_parts).unwrap_or_default())
    }

    pub fn has_pending_sequence(&self) -> bool {
        self.batch(|| self.ensure_valid_pending().is_some())
    }

    pub fn clear_pending_sequence(&self) {
        self.batch(|| self.set_pending(None));
    }

    /// Removes the last stroke of the pending sequence. Returns whether a sequence was pending.
    pub fn pop_pending_sequence(&self) -> bool {
        self.batch(|| {
            let Some(pending) = self.ensure_valid_pending() else { return false };
            if pending[0].index == 0 {
                self.set_pending(None);
                return true;
            }
            let popped: Vec<_> = pending
                .iter()
                .filter(|capture| capture.index > 0)
                .map(|capture| Capture { index: capture.index - 1, ..capture.clone() })
                .collect();
            self.set_pending(if popped.is_empty() { None } else { Some(popped) });
            true
        })
    }

    // Commands.

    /// Runs the first reachable command named `name` that does not reject, as a palette entry would.
    pub fn dispatch_command(&self, name: &str) -> RunResult {
        self.execute(name, false)
    }

    /// Runs a registered command named `name`, whether or not its layer is active or enabled.
    pub fn run_command(&self, name: &str) -> RunResult {
        self.execute(name, true)
    }

    fn execute(&self, name: &str, registered: bool) -> RunResult {
        self.batch(|| {
            let name = name.trim();
            if name.is_empty() {
                return RunResult::InvalidArgs;
            }
            let chain: Vec<Entry<T>> = if registered {
                let state = self.state();
                state
                    .sorted
                    .iter()
                    .flat_map(|layer| {
                        layer
                            .commands
                            .iter()
                            .filter(|command| command.name == name)
                            .map(|command| Entry { layer: layer.clone(), command: command.clone() })
                    })
                    .collect()
            } else {
                self.active_view().chain(name).cloned().collect()
            };
            let focused = self.focused();
            let mut rejected = false;
            for entry in chain {
                let invocation = CommandContext {
                    keymap: self.clone(),
                    event: None,
                    focused: focused.clone(),
                    target: entry.layer.source.target.clone(),
                    input: name.to_owned(),
                    command: Some(entry.command.clone()),
                };
                if (entry.command.run)(&invocation) == Outcome::Handled {
                    return RunResult::Ok;
                }
                rejected = true;
            }
            if !registered && let Some(unavailable) = self.unavailable(name) {
                return unavailable;
            }
            if rejected { RunResult::Rejected } else { RunResult::NotFound }
        })
    }

    fn unavailable(&self, name: &str) -> Option<RunResult> {
        let (layers, focus) = {
            let state = self.state();
            (state.layers.clone(), state.focus.clone())
        };
        let mut inactive = false;
        for layer in layers {
            for command in layer.commands.iter().filter(|command| command.name == name) {
                if !Self::layer_active(&layer, &focus) {
                    inactive = true;
                } else if !self.layer_enabled(&layer) || !command.enabled.check() {
                    return Some(RunResult::Disabled);
                }
            }
        }
        inactive.then_some(RunResult::Inactive)
    }

    // Queries.

    fn registered_entries(&self) -> Vec<Entry<T>> {
        self.state()
            .layers
            .iter()
            .flat_map(|layer| {
                layer.commands.iter().map(|command| Entry { layer: layer.clone(), command: command.clone() })
            })
            .collect()
    }

    fn registered_command(&self, name: &str) -> Option<Rc<Command<T>>> {
        self.state().layers.iter().flat_map(|layer| layer.commands.iter()).find(|command| command.name == name).cloned()
    }

    /// The active view, which `Registered` queries do not read.
    fn query_view(&self, visibility: Visibility) -> Option<Rc<ActiveView<T>>> {
        (visibility != Visibility::Registered).then(|| self.active_view())
    }

    fn query_entries(&self, query: &CommandQuery<T>, view: Option<&ActiveView<T>>) -> Vec<Entry<T>> {
        let entries = match view {
            None => self.registered_entries(),
            Some(view) if query.visibility == Visibility::Active => view.entries.clone(),
            Some(view) => view.reachable_entries(),
        };
        if query.limit == Some(0) {
            return Vec::new();
        }
        let search = query.search.as_deref().map(|search| search.trim().to_lowercase()).unwrap_or_default();
        let fields: Vec<&str> = if query.search_in.is_empty() {
            vec!["name"]
        } else {
            query.search_in.iter().map(String::as_str).collect()
        };
        let mut found = Vec::new();
        for entry in entries {
            let command = &entry.command;
            if let Some(namespaces) = &query.namespace
                && !command.namespace.as_ref().is_some_and(|namespace| namespaces.contains(namespace))
            {
                continue;
            }
            if !search.is_empty()
                && !fields.iter().any(|field| {
                    command_field(command, field).is_some_and(|value| value.to_lowercase().contains(&search))
                })
            {
                continue;
            }
            if let Some(names) = &query.names
                && !names.contains(&command.name)
            {
                continue;
            }
            if let Some(filter) = &query.filter
                && !filter(command)
            {
                continue;
            }
            found.push(entry);
            if query.limit.is_some_and(|limit| found.len() >= limit) {
                break;
            }
        }
        found
    }

    pub fn commands(&self, query: &CommandQuery<T>) -> Vec<Rc<Command<T>>> {
        let view = self.query_view(query.visibility);
        self.query_entries(query, view.as_deref()).into_iter().map(|entry| entry.command).collect()
    }

    /// Commands with the bindings that run them, as the query sees them.
    pub fn command_entries(&self, query: &CommandQuery<T>) -> Vec<CommandEntry<T>> {
        let view = self.query_view(query.visibility);
        let entries = self.query_entries(query, view.as_deref());
        let bindings = self.query_bindings(view.as_deref());
        entries
            .into_iter()
            .map(|entry| CommandEntry {
                bindings: bindings
                    .iter()
                    .filter(|binding| binding_name(binding) == Some(&entry.command.name))
                    .map(|binding| active_binding(binding, Some(entry.command.clone())))
                    .collect(),
                command: entry.command,
            })
            .collect()
    }

    /// The bindings that run each of `names`.
    pub fn command_bindings(&self, visibility: Visibility, names: &[&str]) -> HashMap<String, Vec<ActiveBinding<T>>> {
        let view = self.query_view(visibility);
        let bindings = self.query_bindings(view.as_deref());
        names
            .iter()
            .map(|&name| {
                let info = match &view {
                    None => self.registered_command(name),
                    Some(view) => view.reachable(name).map(|entry| entry.command.clone()),
                };
                let found = bindings
                    .iter()
                    .filter(|binding| binding_name(binding).map(String::as_str) == Some(name))
                    .map(|binding| active_binding(binding, info.clone()))
                    .collect();
                (name.to_owned(), found)
            })
            .collect()
    }

    fn query_bindings(&self, view: Option<&ActiveView<T>>) -> Vec<Rc<BindingState<T>>> {
        let Some(view) = view else {
            return self.state().layers.iter().flat_map(|layer| layer.bindings.iter().cloned()).collect();
        };
        view.layers
            .iter()
            .filter(|layer| !layer.bindings.is_empty() && self.layer_enabled(layer))
            .flat_map(|layer| layer.bindings.iter().filter(|binding| view.visible(binding)).cloned())
            .collect()
    }

    /// The keys that do something now: at the root, or the continuations of the pending sequence.
    pub fn active_keys(&self, options: ActiveKeyOptions) -> Vec<ActiveKey<T>> {
        self.batch(|| {
            let pending = self.ensure_valid_pending();
            let view = self.active_view();
            let mut keys: Vec<KeyState<T>> = Vec::new();
            let mut stopped: Vec<Stroke> = Vec::new();
            match pending {
                Some(pending) => {
                    let options: Vec<_> = pending
                        .iter()
                        .filter_map(|capture| {
                            let index = capture.index + 1;
                            let part = capture.binding.sequence.get(index)?;
                            let length = capture.binding.sequence.len();
                            Some((part, &capture.binding, index + 1 == length, index + 1 < length))
                        })
                        .collect();
                    let mut seen: Vec<&Stroke> = Vec::new();
                    for (part, ..) in &options {
                        if seen.contains(&&part.stroke) {
                            continue;
                        }
                        seen.push(&part.stroke);
                        let matching: Vec<_> = options.iter().filter(|option| option.0.stroke == part.stroke).collect();
                        let exact: Vec<_> =
                            matching.iter().filter(|option| option.2).map(|option| option.1.clone()).collect();
                        let selected = select_bindings(&exact, &view);
                        let continues = matching.iter().any(|option| option.3);
                        if !continues && selected.is_none() {
                            continue;
                        }
                        let (display, token) = presentation(matching.iter().map(|option| option.0));
                        let stop = continues || selected.as_ref().is_some_and(|selected| selected.stop);
                        let selection = Selection { display, token, continues, selected, stop };
                        add_key(&mut keys, &mut stopped, &part.stroke, selection);
                    }
                }
                None => {
                    for layer in &view.layers {
                        if !layer.bindings.iter().any(|binding| binding.event == KeyEventType::Press)
                            || !self.layer_enabled(layer)
                        {
                            continue;
                        }
                        for (stroke, exact, reachable) in root_nodes(layer) {
                            if stopped.contains(&stroke) {
                                continue;
                            }
                            let continues = reachable.iter().any(|binding| binding.sequence.len() > 1);
                            let selection = if continues {
                                let visible: Vec<_> =
                                    reachable.iter().filter(|binding| view.visible(binding)).collect();
                                if visible.is_empty() {
                                    continue;
                                }
                                let (display, token) = presentation(visible.iter().map(|binding| &binding.sequence[0]));
                                Selection {
                                    display,
                                    token,
                                    continues,
                                    selected: select_bindings(&exact, &view),
                                    stop: true,
                                }
                            } else {
                                let Some(selected) = select_bindings(&exact, &view) else { continue };
                                let (display, token) =
                                    presentation(selected.bindings.iter().map(|binding| &binding.sequence[0]));
                                let stop = selected.stop;
                                Selection { display, token, continues, selected: Some(selected), stop }
                            };
                            add_key(&mut keys, &mut stopped, &stroke, selection);
                        }
                    }
                }
            }
            keys.into_iter()
                .filter(|key| key.command_binding.is_some() || key.continues)
                .map(|key| {
                    let info = |binding: &BindingState<T>| {
                        binding_name(binding).and_then(|name| view.reachable(name)).map(|entry| entry.command.clone())
                    };
                    let metadata = options.include_metadata;
                    ActiveKey {
                        stroke: key.stroke,
                        display: key.display,
                        token: key.token,
                        continues: key.continues,
                        command: key.command_binding.as_ref().and_then(|binding| binding.command.clone()),
                        bindings: (options.include_bindings && !key.bindings.is_empty()).then(|| {
                            key.bindings.iter().map(|binding| active_binding(binding, info(binding))).collect()
                        }),
                        desc: key.first.as_ref().filter(|_| metadata).and_then(|binding| binding.desc.clone()),
                        group: key.first.as_ref().filter(|_| metadata).and_then(|binding| binding.group.clone()),
                        command_info: key
                            .command_binding
                            .as_ref()
                            .filter(|_| metadata)
                            .and_then(|binding| info(binding)),
                    }
                })
                .collect()
        })
    }

    // Keys.

    /// Parses a key that must be one stroke, such as `"ctrl+x"` or `"<leader>"`. Compare its `stroke` with
    /// [`Stroke::from_event`] to match events against it, as `createKeyMatcher` does.
    pub fn parse_key(&self, key: impl Into<Key>) -> Result<KeySequencePart, String> {
        key::parse_single(&key.into(), &self.tokens())
    }

    /// Parses a key sequence. A sequence with an unknown token is empty, with a warning.
    pub fn parse_key_sequence(&self, key: impl Into<Key>) -> Result<Vec<KeySequencePart>, String> {
        match key.into() {
            Key::Stroke(stroke) => Ok(vec![KeySequencePart::from_stroke(stroke.normalized()?)]),
            Key::Text(text) => {
                let parsed = key::parse_sequence(&text, &self.tokens())?;
                for token in &parsed.unknown_tokens {
                    self.warn_once(
                        format!("token:{token}"),
                        "unknown-token",
                        format!(
                            "[Keymap] Unknown token \"{token}\" in key sequence \"{text}\"; binding was skipped until \
                             the token is registered"
                        ),
                    );
                }
                Ok(if parsed.unknown_tokens.is_empty() { parsed.parts } else { Vec::new() })
            }
        }
    }

    /// The canonical form of a key sequence, such as `ctrl+xn`.
    pub fn format_key(&self, key: impl Into<Key>) -> Result<String, String> {
        Ok(self.parse_key_sequence(key)?.iter().map(|part| part.stroke.to_string()).collect())
    }
}

/// Removes the first entry that `matches` and returns it.
fn take<E>(list: &mut Vec<E>, matches: impl Fn(&E) -> bool) -> Option<E> {
    let index = list.iter().position(matches)?;
    Some(list.remove(index))
}

fn sort_layers<T>(layers: &mut [Rc<LayerState<T>>]) {
    layers.sort_by(|left, right| right.source.priority.cmp(&left.source.priority).then(right.order.cmp(&left.order)));
}

fn binding_outcome(handled: bool) -> Dispatched {
    Dispatched { handled, reason: if handled { KeyReason::BindingHandled } else { KeyReason::BindingRejected } }
}

fn binding_name<T>(binding: &BindingState<T>) -> Option<&String> {
    match &binding.command {
        Some(BindingCommand::Name(name)) => Some(name),
        _ => None,
    }
}

fn active_binding<T>(binding: &BindingState<T>, command_info: Option<Rc<Command<T>>>) -> ActiveBinding<T> {
    ActiveBinding {
        sequence: binding.sequence.clone(),
        command: binding.command.clone(),
        command_info,
        desc: binding.desc.clone(),
        group: binding.group.clone(),
        event: binding.event,
        prevent_default: binding.prevent_default,
        fallthrough: binding.fallthrough,
    }
}

fn command_field<'a, T>(command: &'a Command<T>, field: &str) -> Option<&'a str> {
    match field {
        "name" => Some(&command.name),
        "title" => command.title.as_deref(),
        "desc" => command.desc.as_deref(),
        "category" => command.category.as_deref(),
        "namespace" => command.namespace.as_deref(),
        _ => None,
    }
}

fn same_pending<T>(current: Option<&[Capture<T>]>, next: Option<&[Capture<T>]>) -> bool {
    match (current, next) {
        (None, None) => true,
        (Some(current), Some(next)) => {
            current.len() == next.len()
                && current.iter().zip(next).all(|(left, right)| {
                    Rc::ptr_eq(&left.layer, &right.layer)
                        && Rc::ptr_eq(&left.binding, &right.binding)
                        && left.index == right.index
                })
        }
        _ => false,
    }
}

/// The pending sequence's strokes, with a display and token only where every capture agrees.
fn sequence_parts<T>(captures: &[Capture<T>]) -> Vec<KeySequencePart> {
    let Some(first) = captures.first() else { return Vec::new() };
    (0..=first.index)
        .map(|index| {
            let (display, token) = presentation(captures.iter().filter_map(|capture| capture.parts().get(index)));
            KeySequencePart { stroke: first.parts()[index].stroke.clone(), display, token }
        })
        .collect()
}

/// The display and token several parts for one key share; a conflicting display falls back to the first stroke's
/// canonical form, and a conflicting token to none.
fn presentation<'a>(mut parts: impl Iterator<Item = &'a KeySequencePart>) -> (String, Option<String>) {
    let Some(first) = parts.next() else { return (String::new(), None) };
    let (mut display_conflict, mut token_conflict) = (false, false);
    for part in parts {
        display_conflict |= part.display != first.display;
        token_conflict |= part.token != first.token;
    }
    let display = if display_conflict { first.stroke.to_string() } else { first.display.clone() };
    (display, if token_conflict { None } else { first.token.clone() })
}

struct Selected<T> {
    bindings: Vec<Rc<BindingState<T>>>,
    command_binding: Option<Rc<BindingState<T>>>,
    stop: bool,
}

/// The visible bindings for a key up to the first that runs a command and does not fall through.
fn select_bindings<T>(bindings: &[Rc<BindingState<T>>], view: &ActiveView<T>) -> Option<Selected<T>> {
    let mut selected = Selected { bindings: Vec::new(), command_binding: None, stop: false };
    for binding in bindings.iter().filter(|binding| view.visible(binding)) {
        selected.bindings.push(binding.clone());
        if binding.command.is_none() {
            continue;
        }
        selected.command_binding.get_or_insert_with(|| binding.clone());
        if !binding.fallthrough {
            selected.stop = true;
            return Some(selected);
        }
    }
    (!selected.bindings.is_empty()).then_some(selected)
}

struct Selection<T> {
    display: String,
    token: Option<String>,
    continues: bool,
    selected: Option<Selected<T>>,
    stop: bool,
}

struct KeyState<T> {
    stroke: Stroke,
    display: String,
    token: Option<String>,
    continues: bool,
    first: Option<Rc<BindingState<T>>>,
    command_binding: Option<Rc<BindingState<T>>>,
    bindings: Vec<Rc<BindingState<T>>>,
}

fn add_key<T>(keys: &mut Vec<KeyState<T>>, stopped: &mut Vec<Stroke>, stroke: &Stroke, selection: Selection<T>) {
    if stopped.contains(stroke) {
        return;
    }
    let (first, command_binding, bindings) = match selection.selected {
        Some(selected) => (selected.bindings.first().cloned(), selected.command_binding, selected.bindings),
        None => (None, None, Vec::new()),
    };
    match keys.iter_mut().find(|key| key.stroke == *stroke) {
        Some(key) => {
            key.first = key.first.take().or(first);
            key.command_binding = key.command_binding.take().or(command_binding);
            key.continues |= selection.continues;
            key.bindings.extend(bindings);
        }
        None => keys.push(KeyState {
            stroke: stroke.clone(),
            display: selection.display,
            token: selection.token,
            continues: selection.continues,
            first,
            command_binding,
            bindings,
        }),
    }
    if selection.stop {
        stopped.push(stroke.clone());
    }
}

/// A layer's first strokes in order, with the press bindings that are exactly that stroke and all that start with it.
#[allow(clippy::type_complexity)]
fn root_nodes<T>(layer: &LayerState<T>) -> Vec<(Stroke, Vec<Rc<BindingState<T>>>, Vec<Rc<BindingState<T>>>)> {
    let mut nodes: Vec<(Stroke, Vec<Rc<BindingState<T>>>, Vec<Rc<BindingState<T>>>)> = Vec::new();
    for binding in layer.bindings.iter().filter(|binding| binding.event == KeyEventType::Press) {
        let stroke = &binding.sequence[0].stroke;
        let index = match nodes.iter().position(|node| node.0 == *stroke) {
            Some(index) => index,
            None => {
                nodes.push((stroke.clone(), Vec::new(), Vec::new()));
                nodes.len() - 1
            }
        };
        if binding.sequence.len() == 1 {
            nodes[index].1.push(binding.clone());
        }
        nodes[index].2.push(binding.clone());
    }
    nodes
}

fn normalize_name(name: &str, what: &str) -> Result<String, String> {
    let trimmed = name.trim();
    if trimmed.is_empty() {
        return Err(format!(
            "Invalid keymap {what}: {} cannot be empty",
            if what == "command" { "command" } else { "name" }
        ));
    }
    Ok(trimmed.to_owned())
}

fn metadata(field: &str, value: &Option<String>) -> Result<Option<String>, String> {
    match value.as_deref().map(str::trim) {
        Some("") => Err(format!("Keymap metadata field \"{field}\" cannot be empty")),
        value => Ok(value.map(str::to_owned)),
    }
}

fn normalize_command<T>(command: &Command<T>) -> Result<Command<T>, String> {
    let name = normalize_name(&command.name, "command name")?;
    if name.contains(char::is_whitespace) {
        return Err(format!(
            "Invalid keymap command name \"{}\": command names cannot contain whitespace",
            command.name
        ));
    }
    Ok(Command {
        name,
        run: command.run.clone(),
        title: metadata("title", &command.title)?,
        desc: metadata("desc", &command.desc)?,
        category: metadata("category", &command.category)?,
        namespace: command.namespace.clone(),
        enabled: command.enabled.clone(),
        data: command.data.clone(),
    })
}

fn compile_binding<T>(
    binding: &Binding<T>,
    sequence: Vec<KeySequencePart>,
    compiled: &[Rc<BindingState<T>>],
) -> Result<Option<BindingState<T>>, String> {
    let desc = metadata("desc", &binding.desc)?;
    let group = metadata("group", &binding.group)?;
    let command = match &binding.cmd {
        Some(BindingCommand::Name(name)) => Some(BindingCommand::Name(normalize_name(name, "command")?)),
        command => command.clone(),
    };
    if sequence.is_empty() {
        return Ok(None);
    }
    if binding.event == KeyEventType::Release && sequence.len() > 1 {
        return Err("Keymap release bindings only support a single key stroke".to_owned());
    }
    let state = BindingState {
        sequence,
        command,
        event: binding.event,
        prevent_default: binding.prevent_default,
        fallthrough: binding.fallthrough,
        desc,
        group,
    };
    if state.event == KeyEventType::Press
        && compiled.iter().any(|existing| {
            existing.event == KeyEventType::Press
                && ((existing.command.is_some() && is_prefix(&existing.sequence, &state.sequence))
                    || (state.command.is_some() && is_prefix(&state.sequence, &existing.sequence)))
        })
    {
        return Err(
            "Keymap bindings cannot use the same sequence as both an exact match and a prefix in the same layer"
                .to_owned(),
        );
    }
    Ok(Some(state))
}

/// Whether `prefix` is a strict prefix of `sequence`.
fn is_prefix(prefix: &[KeySequencePart], sequence: &[KeySequencePart]) -> bool {
    prefix.len() < sequence.len() && prefix.iter().zip(sequence).all(|(left, right)| left.stroke == right.stroke)
}

type Expanded = Vec<(Key, Option<Vec<String>>)>;

fn expand(input: &str, expanders: &[Expander]) -> Result<Expanded, String> {
    let mut candidates = vec![Expansion { key: input.to_owned(), displays: None }];
    for expander in expanders {
        let mut next = Vec::new();
        for candidate in candidates {
            match expander(&ExpanderInput { input: &candidate.key, displays: candidate.displays.as_deref() })? {
                None => next.push(candidate),
                Some(expanded) if expanded.is_empty() => {
                    return Err(format!(
                        "Keymap binding expander must return at least one key sequence for \"{}\"",
                        candidate.key
                    ));
                }
                Some(expanded) => next.extend(expanded),
            }
        }
        candidates = next;
    }
    Ok(candidates.into_iter().map(|candidate| (Key::Text(candidate.key), candidate.displays)).collect())
}

fn apply_displays(mut parsed: Parsed, displays: Option<Vec<String>>, key: &Key) -> Result<Parsed, String> {
    let Some(displays) = displays else { return Ok(parsed) };
    if displays.len() != parsed.parts.len() {
        return Err(format!(
            "Keymap binding expansion displays length must match parsed sequence length for \"{key}\""
        ));
    }
    for (part, display) in parsed.parts.iter_mut().zip(displays) {
        part.display = display;
    }
    Ok(parsed)
}
