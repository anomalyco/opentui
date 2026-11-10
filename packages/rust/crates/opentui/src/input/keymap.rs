//! Shortcuts and key maps: which key presses run which widget actions.

use super::{KeyCode, KeyEvent, KeyEventKind, Modifiers};
use std::fmt;
use std::str::FromStr;

/// A key with modifiers, such as `ctrl+c`, normalized so equal shortcuts compare equal.
///
/// Shift is part of a character: `"shift+a"` and `"A"` are the same shortcut, and both match a key that reports
/// `Char('A')` with or without Shift. Shift+Tab is always [`KeyCode::BackTab`] with Shift. Lock keys are ignored.
///
/// ```
/// use opentui::input::{KeyCode, KeyEvent, Modifiers, Shortcut};
///
/// let save: Shortcut = "ctrl+s".parse().unwrap();
/// assert!(save.matches(&KeyEvent::new(KeyCode::Char('s'), Modifiers::CTRL)));
/// assert_eq!(save.to_string(), "ctrl+s");
/// assert_eq!(Shortcut::parse("shift+a"), Shortcut::parse("A"));
/// ```
#[derive(Clone, Copy, PartialEq, Eq, Hash)]
pub struct Shortcut {
    code: KeyCode,
    modifiers: Modifiers,
}

impl Shortcut {
    pub fn new(code: KeyCode, modifiers: Modifiers) -> Self {
        let mut modifiers = modifiers.without_locks();
        let code = match code {
            KeyCode::Char(character) => {
                let shifted = modifiers.contains(Modifiers::SHIFT);
                modifiers = Modifiers::from_bits(modifiers.bits() & !Modifiers::SHIFT.bits());
                KeyCode::Char(if shifted { single_uppercase(character) } else { character })
            }
            KeyCode::Tab | KeyCode::BackTab if code == KeyCode::BackTab || modifiers.contains(Modifiers::SHIFT) => {
                modifiers |= Modifiers::SHIFT;
                KeyCode::BackTab
            }
            code => code,
        };
        Self { code, modifiers }
    }

    /// Parses names such as `"q"`, `"ctrl+c"`, `"shift+tab"`, `"alt+enter"`, `"ctrl++"`, or `"f5"`.
    ///
    /// Modifiers are `shift`, `alt` (or `option`), `ctrl` (or `control`), `super` (or `cmd`), `hyper`, and `meta`.
    /// Key names are case-insensitive except single characters; `key57441` names a Kitty functional key by number.
    /// Returns `None` for an unknown name.
    pub fn parse(text: &str) -> Option<Self> {
        let mut modifiers = Modifiers::NONE;
        let mut parts = text.split('+').peekable();
        let mut key = None;
        while let Some(part) = parts.next() {
            // A trailing empty part means the key itself is '+', as in "ctrl++".
            let part = if part.is_empty() && parts.peek() == Some(&"") {
                parts.next();
                "+"
            } else {
                part
            };
            if parts.peek().is_some() {
                modifiers |= match part.to_ascii_lowercase().as_str() {
                    "shift" => Modifiers::SHIFT,
                    "alt" | "option" => Modifiers::ALT,
                    "ctrl" | "control" => Modifiers::CTRL,
                    "super" | "cmd" => Modifiers::SUPER,
                    "hyper" => Modifiers::HYPER,
                    "meta" => Modifiers::META,
                    _ => return None,
                };
            } else {
                key = Some(part);
            }
        }
        let key = key?;
        let mut chars = key.chars();
        if let (Some(character), None) = (chars.next(), chars.next()) {
            return Some(Self::new(KeyCode::Char(character), modifiers));
        }
        let lower = key.to_ascii_lowercase();
        let code = match lower.as_str() {
            "return" => KeyCode::Enter,
            "esc" => KeyCode::Escape,
            "del" => KeyCode::Delete,
            "space" => KeyCode::Char(' '),
            name => match NAMED.iter().find(|(_, known)| *known == name) {
                Some(&(code, _)) => code,
                None => match name.strip_prefix('f').and_then(|number| number.parse::<u8>().ok()) {
                    Some(number @ 1..=35) => KeyCode::F(number),
                    _ => KeyCode::Other(name.strip_prefix("key")?.parse().ok()?),
                },
            },
        };
        Some(Self::new(code, modifiers))
    }

    pub fn code(&self) -> KeyCode {
        self.code
    }

    /// The modifiers, without Shift for characters: Shift is part of the character.
    pub fn modifiers(&self) -> Modifiers {
        self.modifiers
    }

    /// Whether a press or repeat of `key` is this shortcut.
    ///
    /// A key from a non-Latin layout also matches through the key at the same position on a US layout, when the
    /// terminal reports it: Ctrl+ㅊ on a Korean layout matches `ctrl+c`.
    pub fn matches(&self, key: &KeyEvent) -> bool {
        if key.kind == KeyEventKind::Release {
            return false;
        }
        if Self::new(key.code, key.modifiers) == *self {
            return true;
        }
        match (key.code, key.base_layout) {
            (KeyCode::Char(character), Some(base)) if !character.is_ascii() => {
                Self::new(KeyCode::Char(base), key.modifiers) == *self
            }
            _ => false,
        }
    }
}

/// Keys with names, as [`Shortcut::parse`] reads and [`Shortcut`]'s `Display` writes them.
const NAMED: &[(KeyCode, &str)] = &[
    (KeyCode::Enter, "enter"),
    (KeyCode::LineFeed, "linefeed"),
    (KeyCode::Tab, "tab"),
    (KeyCode::BackTab, "backtab"),
    (KeyCode::Backspace, "backspace"),
    (KeyCode::Escape, "escape"),
    (KeyCode::Up, "up"),
    (KeyCode::Down, "down"),
    (KeyCode::Left, "left"),
    (KeyCode::Right, "right"),
    (KeyCode::Home, "home"),
    (KeyCode::End, "end"),
    (KeyCode::PageUp, "pageup"),
    (KeyCode::PageDown, "pagedown"),
    (KeyCode::Insert, "insert"),
    (KeyCode::Delete, "delete"),
    (KeyCode::CapsLock, "capslock"),
    (KeyCode::ScrollLock, "scrolllock"),
    (KeyCode::NumLock, "numlock"),
    (KeyCode::PrintScreen, "printscreen"),
    (KeyCode::Pause, "pause"),
    (KeyCode::Menu, "menu"),
    (KeyCode::KeypadBegin, "keypadbegin"),
];

/// The name of a key that is not a character. Shift+Tab shows as `tab`, since Display adds `shift+`.
fn key_name(code: KeyCode) -> std::borrow::Cow<'static, str> {
    match code {
        KeyCode::BackTab => "tab".into(),
        KeyCode::F(number) => format!("f{number}").into(),
        KeyCode::Other(number) => format!("key{number}").into(),
        code => NAMED.iter().find(|(known, _)| *known == code).map_or("unknown", |&(_, name)| name).into(),
    }
}

fn single_uppercase(character: char) -> char {
    let mut upper = character.to_uppercase();
    match (upper.next(), upper.next()) {
        (Some(single), None) => single,
        _ => character,
    }
}

impl From<KeyCode> for Shortcut {
    fn from(code: KeyCode) -> Self {
        Self::new(code, Modifiers::NONE)
    }
}

impl From<KeyEvent> for Shortcut {
    fn from(key: KeyEvent) -> Self {
        Self::new(key.code, key.modifiers)
    }
}

/// The error for an unknown shortcut name.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ParseShortcutError(pub String);

impl fmt::Display for ParseShortcutError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(formatter, "unknown shortcut {:?}", self.0)
    }
}

impl std::error::Error for ParseShortcutError {}

impl FromStr for Shortcut {
    type Err = ParseShortcutError;

    fn from_str(text: &str) -> Result<Self, Self::Err> {
        Self::parse(text).ok_or_else(|| ParseShortcutError(text.to_owned()))
    }
}

/// Writes the shortcut in the form [`Shortcut::parse`] reads, such as `ctrl+shift+a` or `alt+enter`.
impl fmt::Display for Shortcut {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        let mut modifiers = self.modifiers;
        let name = match self.code {
            KeyCode::Char(character) => {
                let lower: String = character.to_lowercase().collect();
                if lower.chars().count() == 1 && lower != character.to_string() {
                    modifiers |= Modifiers::SHIFT;
                    lower
                } else {
                    character.to_string()
                }
            }
            code => key_name(code).into_owned(),
        };
        let name = if name == " " { "space".to_owned() } else { name };
        for (modifier, label) in [
            (Modifiers::CTRL, "ctrl"),
            (Modifiers::ALT, "alt"),
            (Modifiers::SHIFT, "shift"),
            (Modifiers::SUPER, "super"),
            (Modifiers::HYPER, "hyper"),
            (Modifiers::META, "meta"),
        ] {
            if modifiers.contains(modifier) {
                write!(formatter, "{label}+")?;
            }
        }
        formatter.write_str(&name)
    }
}

impl fmt::Debug for Shortcut {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(formatter, "Shortcut({self})")
    }
}

/// Values that name a shortcut: a [`Shortcut`], a [`KeyCode`], a [`KeyEvent`], or a name such as `"ctrl+s"`.
///
/// # Panics
///
/// Converting an unknown name panics. Names in code are fixed, so a typo shows up the first time the code runs;
/// parse user-supplied names with [`Shortcut::parse`] instead.
pub trait IntoShortcut {
    fn into_shortcut(self) -> Shortcut;
}

impl IntoShortcut for Shortcut {
    fn into_shortcut(self) -> Shortcut {
        self
    }
}

impl IntoShortcut for KeyCode {
    fn into_shortcut(self) -> Shortcut {
        self.into()
    }
}

impl IntoShortcut for KeyEvent {
    fn into_shortcut(self) -> Shortcut {
        self.into()
    }
}

impl IntoShortcut for &str {
    fn into_shortcut(self) -> Shortcut {
        Shortcut::parse(self).unwrap_or_else(|| panic!("opentui: unknown shortcut {self:?}"))
    }
}

impl IntoShortcut for &String {
    fn into_shortcut(self) -> Shortcut {
        self.as_str().into_shortcut()
    }
}

/// Shortcuts and the actions they run, such as a widget's key bindings.
///
/// Each shortcut runs at most one action; binding a shortcut again replaces its action. Iteration keeps the order
/// shortcuts were first bound in, so help screens list them in a stable order.
///
/// ```
/// use opentui::input::{KeyCode, KeyEvent, Keymap, Modifiers};
///
/// #[derive(Clone, Copy, Debug, PartialEq)]
/// enum Action { Save, Quit }
///
/// let keymap = Keymap::new().bind("ctrl+s", Action::Save).bind("q", Action::Quit).bind("ctrl+q", Action::Quit);
/// assert_eq!(keymap.get(&KeyEvent::new(KeyCode::Char('s'), Modifiers::CTRL)), Some(Action::Save));
/// assert_eq!(keymap.shortcuts(Action::Quit).map(|s| s.to_string()).collect::<Vec<_>>(), ["q", "ctrl+q"]);
/// ```
#[derive(Clone, PartialEq)]
#[must_use]
pub struct Keymap<A> {
    entries: Vec<(Shortcut, A)>,
}

impl<A> Default for Keymap<A> {
    fn default() -> Self {
        Self { entries: Vec::new() }
    }
}

impl<A: Copy + PartialEq> Keymap<A> {
    /// An empty key map.
    pub fn new() -> Self {
        Self::default()
    }

    /// Binds `shortcut` to `action`, replacing its earlier action, and returns the map for chaining.
    pub fn bind(mut self, shortcut: impl IntoShortcut, action: A) -> Self {
        self.insert(shortcut, action);
        self
    }

    /// Removes the binding for `shortcut`, if any, and returns the map for chaining.
    pub fn unbind(mut self, shortcut: impl IntoShortcut) -> Self {
        self.remove(shortcut);
        self
    }

    /// Binds `shortcut` to `action`. Returns the action it replaced.
    pub fn insert(&mut self, shortcut: impl IntoShortcut, action: A) -> Option<A> {
        let shortcut = shortcut.into_shortcut();
        match self.entries.iter_mut().find(|(bound, _)| *bound == shortcut) {
            Some((_, bound)) => Some(std::mem::replace(bound, action)),
            None => {
                self.entries.push((shortcut, action));
                None
            }
        }
    }

    /// Removes the binding for `shortcut`. Returns its action.
    pub fn remove(&mut self, shortcut: impl IntoShortcut) -> Option<A> {
        let shortcut = shortcut.into_shortcut();
        let index = self.entries.iter().position(|(bound, _)| *bound == shortcut)?;
        Some(self.entries.remove(index).1)
    }

    /// Removes every binding for `action`.
    pub fn remove_action(&mut self, action: A) {
        self.entries.retain(|(_, bound)| *bound != action);
    }

    /// The action `key` runs, if any. An exact match wins over a match through the key's base layout.
    pub fn get(&self, key: &KeyEvent) -> Option<A> {
        if key.kind == KeyEventKind::Release {
            return None;
        }
        let exact = Shortcut::new(key.code, key.modifiers);
        self.lookup(exact)
            .or_else(|| self.entries.iter().find(|(shortcut, _)| shortcut.matches(key)).map(|&(_, action)| action))
    }

    /// The action bound to exactly `shortcut`.
    pub fn lookup(&self, shortcut: impl IntoShortcut) -> Option<A> {
        let shortcut = shortcut.into_shortcut();
        self.entries.iter().find(|(bound, _)| *bound == shortcut).map(|&(_, action)| action)
    }

    /// The shortcuts that run `action`, in binding order.
    pub fn shortcuts(&self, action: A) -> impl Iterator<Item = Shortcut> + '_ {
        self.entries.iter().filter(move |(_, bound)| *bound == action).map(|&(shortcut, _)| shortcut)
    }

    pub fn iter(&self) -> impl Iterator<Item = (Shortcut, A)> + '_ {
        self.entries.iter().copied()
    }

    pub fn len(&self) -> usize {
        self.entries.len()
    }

    pub fn is_empty(&self) -> bool {
        self.entries.is_empty()
    }

    pub fn clear(&mut self) {
        self.entries.clear();
    }
}

impl<A: Copy + PartialEq, S: IntoShortcut> FromIterator<(S, A)> for Keymap<A> {
    fn from_iter<I: IntoIterator<Item = (S, A)>>(iter: I) -> Self {
        let mut keymap = Self::new();
        for (shortcut, action) in iter {
            keymap.insert(shortcut, action);
        }
        keymap
    }
}

impl<A: Copy + PartialEq, S: IntoShortcut> Extend<(S, A)> for Keymap<A> {
    fn extend<I: IntoIterator<Item = (S, A)>>(&mut self, iter: I) {
        for (shortcut, action) in iter {
            self.insert(shortcut, action);
        }
    }
}

impl<A: fmt::Debug> fmt::Debug for Keymap<A> {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.debug_map().entries(self.entries.iter().map(|(shortcut, action)| (shortcut, action))).finish()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn key(code: KeyCode, modifiers: Modifiers) -> KeyEvent {
        KeyEvent::new(code, modifiers)
    }

    #[test]
    fn shortcuts_normalize_shift_and_tab() {
        let parse = |text| Shortcut::parse(text).unwrap();
        assert_eq!(parse("shift+a"), parse("A"));
        assert_eq!(parse("ctrl+shift+a"), parse("ctrl+A"));
        assert_ne!(parse("ctrl+a"), parse("ctrl+A"));
        assert_eq!(parse("shift+tab"), parse("backtab"));
        assert_eq!(parse("Ctrl+Enter"), parse("ctrl+return"));
        assert!(parse("shift+tab").matches(&key(KeyCode::BackTab, Modifiers::SHIFT)));
        assert!(parse("backtab").matches(&key(KeyCode::BackTab, Modifiers::NONE)));
    }

    #[test]
    fn shortcuts_display_round_trips() {
        for text in
            ["q", "ctrl+c", "ctrl+shift+a", "alt+enter", "ctrl++", "space", "shift+tab", "f12", "pageup", "linefeed"]
        {
            let shortcut = Shortcut::parse(text).unwrap();
            assert_eq!(shortcut.to_string(), text);
            assert_eq!(Shortcut::parse(&shortcut.to_string()), Some(shortcut));
        }
        assert_eq!(Shortcut::parse("A").unwrap().to_string(), "shift+a");
        assert_eq!("ctrl+nope".parse::<Shortcut>(), Err(ParseShortcutError("ctrl+nope".into())));
    }

    #[test]
    fn base_layout_only_applies_to_non_latin_characters() {
        let ctrl_c = Shortcut::parse("ctrl+c").unwrap();
        let korean = KeyEvent { base_layout: Some('c'), ..key(KeyCode::Char('ㅊ'), Modifiers::CTRL) };
        assert!(ctrl_c.matches(&korean));
        // Ctrl+A on AZERTY sits on the US "q" key; it must not run a Ctrl+Q binding.
        let azerty = KeyEvent { base_layout: Some('q'), ..key(KeyCode::Char('a'), Modifiers::CTRL) };
        assert!(!Shortcut::parse("ctrl+q").unwrap().matches(&azerty));
        let keymap = Keymap::new().bind("ctrl+q", 1).bind("ctrl+c", 2);
        assert_eq!(keymap.get(&azerty), None);
        assert_eq!(keymap.get(&korean), Some(2));
    }

    #[test]
    fn keymaps_replace_and_remove() {
        let mut keymap = Keymap::new().bind("up", 'u').bind("k", 'u').bind("down", 'd');
        assert_eq!(keymap.insert("k", 'x'), Some('u'));
        assert_eq!(keymap.get(&key(KeyCode::Char('k'), Modifiers::NONE)), Some('x'));
        assert_eq!(keymap.remove("up"), Some('u'));
        assert_eq!(keymap.get(&key(KeyCode::Up, Modifiers::NONE)), None);
        keymap.remove_action('d');
        assert_eq!(keymap.len(), 1);
        let release = KeyEvent { kind: KeyEventKind::Release, ..key(KeyCode::Char('k'), Modifiers::NONE) };
        assert_eq!(keymap.get(&release), None);
    }
}
