use super::keymap::{IntoShortcut, Shortcut};
use std::fmt;
use std::ops::{BitAnd, BitOr, BitOrAssign, Not};

/// One input event from the terminal or the host.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Event {
    Key(KeyEvent),
    Mouse(MouseEvent),
    /// Bracketed paste. The terminal delivers it as one unit, never as keys.
    Paste(String),
    /// The terminal window gained (`true`) or lost focus.
    Focus(bool),
    /// The terminal changed size, in cells.
    Resize {
        width: u16,
        height: u16,
    },
    /// Another thread called [`Waker::wake`](crate::term::Waker::wake).
    Wake,
    /// The process continued after a suspension and the terminal is set up again. Paint a new frame.
    Resumed,
    /// The terminal reported a background color of a new brightness: at setup, or after its color scheme changed.
    ThemeMode(crate::theme::ThemeMode),
    /// The terminal said its color scheme changed (`CSI ? 997 ; 1 n` or `; 2 n`, while mode 2031 is on). Its palette
    /// may have changed too, even when the brightness did not.
    ColorScheme,
    /// The terminal reported one of its colors, answering an OSC 4, 10, 11, or 12 query.
    Color(super::OscColor),
    /// The process received SIGINT, SIGTERM, or SIGHUP, or input reached end of file.
    Terminate,
}

/// Modifier keys held during a key or mouse event.
#[derive(Clone, Copy, Default, PartialEq, Eq, Hash)]
#[must_use]
pub struct Modifiers(u8);

impl Modifiers {
    pub const NONE: Self = Self(0);
    pub const SHIFT: Self = Self(1);
    pub const ALT: Self = Self(2);
    pub const CTRL: Self = Self(4);
    pub const SUPER: Self = Self(8);
    pub const HYPER: Self = Self(16);
    pub const META: Self = Self(32);
    pub const CAPS_LOCK: Self = Self(64);
    pub const NUM_LOCK: Self = Self(128);

    pub const fn bits(self) -> u8 {
        self.0
    }

    /// Decodes the terminal's modifier bits: the encoded parameter minus one.
    pub const fn from_bits(bits: u8) -> Self {
        Self(bits)
    }

    pub const fn contains(self, other: Self) -> bool {
        self.0 & other.0 == other.0
    }

    pub const fn union(self, other: Self) -> Self {
        Self(self.0 | other.0)
    }

    pub const fn is_empty(self) -> bool {
        self.0 == 0
    }

    /// The modifiers that change a shortcut's meaning: lock keys are ignored.
    pub const fn without_locks(self) -> Self {
        Self(self.0 & !(Self::CAPS_LOCK.0 | Self::NUM_LOCK.0))
    }
}

impl BitOr for Modifiers {
    type Output = Self;
    fn bitor(self, other: Self) -> Self {
        self.union(other)
    }
}

impl BitOrAssign for Modifiers {
    fn bitor_assign(&mut self, other: Self) {
        *self = self.union(other);
    }
}

impl BitAnd for Modifiers {
    type Output = Self;
    fn bitand(self, other: Self) -> Self {
        Self(self.0 & other.0)
    }
}

impl Not for Modifiers {
    type Output = Self;
    fn not(self) -> Self {
        Self(!self.0)
    }
}

impl fmt::Debug for Modifiers {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        const NAMES: [&str; 8] = ["shift", "alt", "ctrl", "super", "hyper", "meta", "caps_lock", "num_lock"];
        let mut names = NAMES.iter().enumerate().filter(|(bit, _)| self.0 & (1 << bit) != 0).map(|(_, name)| *name);
        match names.next() {
            None => formatter.write_str("NONE"),
            Some(first) => {
                formatter.write_str(first)?;
                names.try_for_each(|name| write!(formatter, "+{name}"))
            }
        }
    }
}

/// Which key an event names.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub enum KeyCode {
    /// A text key. Shift is already applied: Shift+a reports `'A'`.
    Char(char),
    Enter,
    /// A legacy line feed byte, which terminals send for Ctrl+J and some for Ctrl+Enter. Core names it `linefeed`, apart
    /// from Enter.
    LineFeed,
    Tab,
    /// Shift+Tab.
    BackTab,
    Backspace,
    Escape,
    Up,
    Down,
    Left,
    Right,
    Home,
    End,
    PageUp,
    PageDown,
    Insert,
    Delete,
    /// Function keys F1 through F35.
    F(u8),
    CapsLock,
    ScrollLock,
    NumLock,
    PrintScreen,
    Pause,
    Menu,
    /// The keypad's center key.
    KeypadBegin,
    /// A Kitty functional key this crate does not name, such as a media or modifier key.
    Other(u32),
}

/// Whether a key went down, repeated, or came up. Terminals without Kitty event reporting send only presses.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Hash)]
pub enum KeyEventKind {
    #[default]
    Press,
    Repeat,
    Release,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub struct KeyEvent {
    pub code: KeyCode,
    pub modifiers: Modifiers,
    pub kind: KeyEventKind,
    /// The key at the same position on a US keyboard, when the terminal reports it and it differs from the typed
    /// key (Kitty's alternate-key reporting). Shortcuts use it for keys from non-Latin layouts.
    pub base_layout: Option<char>,
    /// A keypad key from a Kitty terminal, whose code is the key it stands for: keypad 1 is `Char('1')`, and keypad
    /// Enter is `Enter`. Shortcuts match it as that key; [`Stroke`](crate::keymap::Stroke) names it as Core does,
    /// such as `kp1` or `kpenter`. Legacy terminals send keypad keys as the keys they stand for.
    pub keypad: bool,
}

impl KeyEvent {
    pub const fn new(code: KeyCode, modifiers: Modifiers) -> Self {
        Self { code, modifiers, kind: KeyEventKind::Press, base_layout: None, keypad: false }
    }

    /// Whether this press or repeat matches a shortcut such as `"q"`, `"ctrl+c"`, `"shift+tab"`, or `"alt+enter"`,
    /// or a [`Shortcut`] or [`KeyCode`]. See [`Shortcut`] for the rules.
    ///
    /// # Panics
    ///
    /// Panics if `shortcut` is a name [`Shortcut::parse`] rejects, as [`Keymap::bind`](super::Keymap::bind) does, so a
    /// typo shows up the first time a key arrives instead of never matching. Check names from configuration files
    /// with [`Shortcut::parse`].
    pub fn matches(&self, shortcut: impl IntoShortcut) -> bool {
        shortcut.into_shortcut().matches(self)
    }

    /// The press a shortcut names, such as `"ctrl+c"` or `"shift+a"`, as a terminal reports it: Shift applies to
    /// characters, so `"shift+a"` gives `Char('A')` with SHIFT. Returns `None` for an unknown shortcut name.
    pub fn from_shortcut(shortcut: &str) -> Option<Self> {
        let shortcut = Shortcut::parse(shortcut)?;
        let mut modifiers = shortcut.modifiers();
        if let KeyCode::Char(character) = shortcut.code()
            && character.to_lowercase().ne(std::iter::once(character))
        {
            modifiers |= Modifiers::SHIFT;
        }
        Some(Self::new(shortcut.code(), modifiers))
    }
}

impl From<KeyCode> for KeyEvent {
    fn from(code: KeyCode) -> Self {
        Self::new(code, Modifiers::NONE)
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub enum MouseButton {
    Left,
    Middle,
    Right,
    /// Extra buttons, numbered from 8 as terminals report them (8 is usually Back, 9 Forward).
    Other(u8),
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub enum MouseEventKind {
    Down(MouseButton),
    Up(MouseButton),
    Drag(MouseButton),
    /// Motion without a pressed button. Needs [`MouseTracking::Motion`](crate::native::MouseTracking::Motion).
    Moved,
    ScrollUp,
    ScrollDown,
    ScrollLeft,
    ScrollRight,
}

/// A mouse event at a zero-based cell.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub struct MouseEvent {
    pub kind: MouseEventKind,
    pub x: u16,
    pub y: u16,
    pub modifiers: Modifiers,
}

#[cfg(test)]
mod tests {
    use super::*;

    fn key(code: KeyCode, modifiers: Modifiers) -> KeyEvent {
        KeyEvent::new(code, modifiers)
    }

    #[test]
    fn shortcuts_match_codes_and_modifiers() {
        assert!(key(KeyCode::Char('q'), Modifiers::NONE).matches("q"));
        assert!(!key(KeyCode::Char('q'), Modifiers::CTRL).matches("q"));
        assert!(key(KeyCode::Char('c'), Modifiers::CTRL).matches("ctrl+c"));
        assert!(key(KeyCode::Char('c'), Modifiers::CTRL | Modifiers::CAPS_LOCK).matches("Ctrl+c"));
        assert!(key(KeyCode::Char('A'), Modifiers::SHIFT).matches("A"));
        assert!(key(KeyCode::Char('A'), Modifiers::SHIFT).matches("shift+a"));
        assert!(key(KeyCode::Char('A'), Modifiers::NONE).matches("A"));
        assert!(!key(KeyCode::Char('a'), Modifiers::NONE).matches("A"));
        assert!(key(KeyCode::BackTab, Modifiers::SHIFT).matches("shift+tab"));
        assert!(key(KeyCode::Enter, Modifiers::ALT).matches("alt+enter"));
        assert!(key(KeyCode::Char(' '), Modifiers::CTRL).matches("ctrl+space"));
        assert!(key(KeyCode::Char('+'), Modifiers::CTRL).matches("ctrl++"));
        assert!(key(KeyCode::F(5), Modifiers::NONE).matches("F5"));
        assert!(key(KeyCode::Enter, Modifiers::NONE).matches(KeyCode::Enter));
        assert!(key(KeyCode::Char('s'), Modifiers::CTRL).matches(Shortcut::parse("ctrl+s").unwrap()));
        for invalid in ["", "ctrl+", "hyperspace+x", "f36", "ctrl+nope"] {
            let typo = std::panic::catch_unwind(|| key(KeyCode::Char('x'), Modifiers::CTRL).matches(invalid));
            assert!(typo.is_err(), "{invalid}");
        }
        let release = KeyEvent { kind: KeyEventKind::Release, ..key(KeyCode::Char('q'), Modifiers::NONE) };
        assert!(!release.matches("q"));
    }

    #[test]
    fn modifiers_debug_lists_names() {
        assert_eq!(format!("{:?}", Modifiers::CTRL | Modifiers::SHIFT), "shift+ctrl");
        assert_eq!(format!("{:?}", Modifiers::NONE), "NONE");
    }
}
