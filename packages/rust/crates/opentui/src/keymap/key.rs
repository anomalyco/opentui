//! Key strokes, key sequences, and the default binding syntax.

use crate::input::{KeyCode, KeyEvent, Modifiers};
use crate::tables::{KITTY_KEY_NAMES, MODIFIER_KEYS, NAMED_KEYS};
use std::collections::HashMap;
use std::fmt;

/// One key with modifiers, named as OpenTUI Core names keys: `return`, `escape`, `pageup`, `space`, `f5`, or the
/// character. Alt and Meta are both `meta`, as Core reports them.
///
/// Two strokes match when their normalized names and modifiers are equal. Build strokes with [`Stroke::new`] or
/// [`Stroke::from_event`], which normalize the name to lower case.
#[derive(Clone, Debug, Default, PartialEq, Eq, Hash)]
pub struct Stroke {
    pub name: String,
    pub ctrl: bool,
    pub shift: bool,
    pub meta: bool,
    pub super_: bool,
    pub hyper: bool,
}

impl Stroke {
    pub fn new(name: &str) -> Self {
        Self { name: name.trim().to_lowercase(), ..Self::default() }
    }

    pub fn ctrl(mut self) -> Self {
        self.ctrl = true;
        self
    }

    pub fn shift(mut self) -> Self {
        self.shift = true;
        self
    }

    pub fn meta(mut self) -> Self {
        self.meta = true;
        self
    }

    pub fn super_(mut self) -> Self {
        self.super_ = true;
        self
    }

    pub fn hyper(mut self) -> Self {
        self.hyper = true;
        self
    }

    /// The stroke Core reports for a key event: Shift+a is `a` with Shift, Shift+Tab is `tab` with Shift, Enter is
    /// `return`, a keypad key is `kp1` or `kpenter`, and Alt or Meta set `meta`.
    pub fn from_event(event: &KeyEvent) -> Self {
        let modifiers = event.modifiers;
        let mut shift = modifiers.contains(Modifiers::SHIFT);
        let name = match (event.keypad.then(|| keypad_name(event.code)).flatten(), event.code) {
            (Some(name), _) => name.to_owned(),
            (None, KeyCode::Char(' ')) => "space".to_owned(),
            (None, KeyCode::Char(character)) => {
                let lower: String = character.to_lowercase().collect();
                if lower != character.to_string() {
                    shift = true;
                }
                lower
            }
            (None, KeyCode::BackTab) => {
                shift = true;
                "tab".to_owned()
            }
            (None, KeyCode::F(number)) => format!("f{number}"),
            (None, KeyCode::Other(code)) => other_key_name(code),
            (None, code) => named_code(code).to_owned(),
        };
        Self {
            name,
            ctrl: modifiers.contains(Modifiers::CTRL),
            shift,
            meta: modifiers.contains(Modifiers::ALT) || modifiers.contains(Modifiers::META),
            super_: modifiers.contains(Modifiers::SUPER),
            hyper: modifiers.contains(Modifiers::HYPER),
        }
    }

    pub(crate) fn normalized(&self) -> Result<Self, String> {
        let name = self.name.trim().to_lowercase();
        if name.is_empty() {
            return Err("Invalid key name: key name cannot be empty".to_owned());
        }
        Ok(Self { name, ..self.clone() })
    }
}

/// Writes the canonical form, such as `ctrl+shift+a`; `return` writes as `enter`.
impl fmt::Display for Stroke {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        for (on, label) in [
            (self.ctrl, "ctrl"),
            (self.shift, "shift"),
            (self.meta, "meta"),
            (self.super_, "super"),
            (self.hyper, "hyper"),
        ] {
            if on {
                write!(formatter, "{label}+")?;
            }
        }
        formatter.write_str(if self.name == "return" { "enter" } else { &self.name })
    }
}

/// Core's name for a Kitty keypad key, by the key it stands for. A keypad key whose Kitty text replaced its character
/// has no name here and is named as that character.
fn keypad_name(code: KeyCode) -> Option<&'static str> {
    Some(match code {
        KeyCode::Char(digit @ '0'..='9') => {
            ["kp0", "kp1", "kp2", "kp3", "kp4", "kp5", "kp6", "kp7", "kp8", "kp9"][digit as usize - '0' as usize]
        }
        KeyCode::Char('.') => "kpdecimal",
        KeyCode::Char('/') => "kpdivide",
        KeyCode::Char('*') => "kpmultiply",
        KeyCode::Char('-') => "kpminus",
        KeyCode::Char('+') => "kpplus",
        KeyCode::Char('=') => "kpequal",
        KeyCode::Char(',') => "kpseparator",
        KeyCode::Enter => "kpenter",
        KeyCode::Left => "kpleft",
        KeyCode::Right => "kpright",
        KeyCode::Up => "kpup",
        KeyCode::Down => "kpdown",
        KeyCode::PageUp => "kppageup",
        KeyCode::PageDown => "kppagedown",
        KeyCode::Home => "kphome",
        KeyCode::End => "kpend",
        KeyCode::Insert => "kpinsert",
        KeyCode::Delete => "kpdelete",
        _ => return None,
    })
}

fn named_code(code: KeyCode) -> &'static str {
    match code {
        KeyCode::Enter => "return",
        KeyCode::LineFeed => "linefeed",
        KeyCode::Tab | KeyCode::BackTab => "tab",
        KeyCode::Backspace => "backspace",
        KeyCode::Escape => "escape",
        KeyCode::Up => "up",
        KeyCode::Down => "down",
        KeyCode::Left => "left",
        KeyCode::Right => "right",
        KeyCode::Home => "home",
        KeyCode::End => "end",
        KeyCode::PageUp => "pageup",
        KeyCode::PageDown => "pagedown",
        KeyCode::Insert => "insert",
        KeyCode::Delete => "delete",
        KeyCode::CapsLock => "capslock",
        KeyCode::ScrollLock => "scrolllock",
        KeyCode::NumLock => "numlock",
        KeyCode::PrintScreen => "printscreen",
        KeyCode::Pause => "pause",
        KeyCode::Menu => "menu",
        KeyCode::KeypadBegin => "clear",
        KeyCode::Char(_) | KeyCode::F(_) | KeyCode::Other(_) => unreachable!("named separately"),
    }
}

/// Core's names for the Kitty functional keys this crate reports as [`KeyCode::Other`].
fn other_key_name(code: u32) -> String {
    code.checked_sub(crate::sys::OT_INPUT_KEY_MEDIA_PLAY)
        .and_then(|index| KITTY_KEY_NAMES.get(index as usize))
        .map_or_else(|| format!("key{code}"), |name| (*name).to_owned())
}

/// One stroke of a binding's sequence, with how to show it and the token it came from, such as `leader`.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct KeySequencePart {
    pub stroke: Stroke,
    pub display: String,
    pub token: Option<String>,
}

impl KeySequencePart {
    pub(crate) fn from_stroke(stroke: Stroke) -> Self {
        Self { display: stroke.to_string(), stroke, token: None }
    }
}

/// A binding's key: the binding syntax, such as `"ctrl+x"`, `"<leader>n"`, or `"gg"`, or one stroke.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Key {
    Text(String),
    Stroke(Stroke),
}

impl From<&str> for Key {
    fn from(text: &str) -> Self {
        Self::Text(text.to_owned())
    }
}

impl From<String> for Key {
    fn from(text: String) -> Self {
        Self::Text(text)
    }
}

impl From<Stroke> for Key {
    fn from(stroke: Stroke) -> Self {
        Self::Stroke(stroke)
    }
}

impl fmt::Display for Key {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Key::Text(text) => formatter.write_str(text),
            Key::Stroke(stroke) => stroke.fmt(formatter),
        }
    }
}

/// A parsed key sequence and the tokens it referred to.
pub(crate) struct Parsed {
    pub parts: Vec<KeySequencePart>,
    pub used_tokens: bool,
    pub unknown_tokens: Vec<String>,
}

#[derive(Default)]
struct Modifier {
    ctrl: bool,
    shift: bool,
    meta: bool,
    super_: bool,
    hyper: bool,
}

impl Modifier {
    /// Sets the modifier `name` names, or returns false for a key name.
    fn set(&mut self, name: &str) -> bool {
        match name {
            "ctrl" | "control" => self.ctrl = true,
            "shift" => self.shift = true,
            "meta" | "alt" | "option" => self.meta = true,
            "super" => self.super_ = true,
            "hyper" => self.hyper = true,
            _ => return false,
        }
        true
    }

    fn part(self, name: &str, display_name: &str) -> KeySequencePart {
        let mut display = String::new();
        for (on, label) in [
            (self.ctrl, "ctrl"),
            (self.shift, "shift"),
            (self.meta, "meta"),
            (self.super_, "super"),
            (self.hyper, "hyper"),
        ] {
            if on {
                display.push_str(label);
                display.push('+');
            }
        }
        display.push_str(display_name);
        let stroke = Stroke {
            name: if name == " " { "space".to_owned() } else { name.to_lowercase() },
            ctrl: self.ctrl,
            shift: self.shift,
            meta: self.meta,
            super_: self.super_,
            hyper: self.hyper,
        };
        KeySequencePart { stroke, display, token: None }
    }
}

/// The longest name in `names` that `input` starts with at `index`, ignoring ASCII case.
fn prefix_match(names: &[&'static str], input: &str, index: usize) -> Option<&'static str> {
    let rest = &input.as_bytes()[index..];
    names
        .iter()
        .filter(|name| rest.len() >= name.len() && rest[..name.len()].eq_ignore_ascii_case(name.as_bytes()))
        .max_by_key(|name| name.len())
        .copied()
}

/// A named key at `index`, or a function key such as `f5` or `f12`.
fn named_key(input: &str, index: usize) -> Option<String> {
    if let Some(name) = prefix_match(NAMED_KEYS, input, index) {
        return Some(name.to_owned());
    }
    let bytes = &input.as_bytes()[index..];
    if bytes.len() < 2 || !bytes[0].eq_ignore_ascii_case(&b'f') || !bytes[1].is_ascii_digit() {
        return None;
    }
    let end = if bytes.get(2).is_some_and(u8::is_ascii_digit) { 3 } else { 2 };
    Some(input[index..index + end].to_lowercase())
}

/// The binding syntax for one stroke written as text, such as `"ctrl + x"`, `"x"`, or `"+"`.
fn string_part(input: &str) -> Result<KeySequencePart, String> {
    if input == " " {
        return Ok(KeySequencePart { stroke: Stroke::new("space"), display: "space".to_owned(), token: None });
    }
    if input == "+" {
        return Ok(KeySequencePart { stroke: Stroke::new("+"), display: "+".to_owned(), token: None });
    }
    let mut modifiers = Modifier::default();
    let mut name: Option<&str> = None;
    for part in input.split('+').map(str::trim).filter(|part| !part.is_empty()) {
        if modifiers.set(&part.to_lowercase()) {
            continue;
        }
        if name.is_some() {
            return Err(format!("Invalid key \"{input}\": multiple key names are not supported"));
        }
        name = Some(part);
    }
    let name = name.ok_or_else(|| format!("Invalid key \"{input}\": missing key name"))?;
    Ok(modifiers.part(name, &name.to_lowercase()))
}

/// Modifiers followed by a key at `index`, such as `ctrl+shift+a`, with the index after it.
fn modified_part(input: &str, index: usize) -> Result<Option<(KeySequencePart, usize)>, String> {
    let mut cursor = index;
    let mut modifiers = Modifier::default();
    while cursor < input.len() {
        let Some(modifier) = prefix_match(MODIFIER_KEYS, input, cursor) else { break };
        let plus = cursor + modifier.len();
        if input.as_bytes().get(plus) != Some(&b'+') {
            break;
        }
        modifiers.set(modifier);
        cursor = plus + 1;
    }
    if cursor == index {
        return Ok(None);
    }
    let Some(character) = input[cursor..].chars().next() else {
        return Err(format!("Invalid key \"{}\": missing key name", &input[index..]));
    };
    let name = named_key(input, cursor).unwrap_or_else(|| character.to_string());
    let display = match name.as_str() {
        " " => "space".to_owned(),
        "+" => "+".to_owned(),
        name => name.to_lowercase(),
    };
    let next = cursor + name.len();
    Ok(Some((modifiers.part(&name, &display), next)))
}

/// Parses the default binding syntax: modifiers joined by `+`, named keys, `<token>` references, single
/// characters, and sequences of these, as `@opentui/keymap`'s default parser does. `{pattern}` references are
/// reported as unknown tokens, since this engine has no sequence patterns.
pub(crate) fn parse_sequence(input: &str, tokens: &HashMap<String, Stroke>) -> Result<Parsed, String> {
    if input.is_empty() {
        return Err("Invalid key sequence: sequence cannot be empty".to_owned());
    }
    let mut parsed = Parsed { parts: Vec::new(), used_tokens: false, unknown_tokens: Vec::new() };
    if input.contains('+') && input.contains(char::is_whitespace) {
        parsed.parts.push(string_part(input)?);
        return Ok(parsed);
    }
    let mut index = 0;
    while let Some(character) = input[index..].chars().next() {
        if let Some((open, close)) = [('<', '>'), ('{', '}')].into_iter().find(|(open, _)| *open == character)
            && let Some(end) = input[index..].find(close).map(|end| index + end)
        {
            let name = normalize_token(&input[index + 1..end])?;
            parsed.used_tokens = true;
            match tokens.get(&name).filter(|_| open == '<') {
                Some(stroke) => parsed.parts.push(KeySequencePart {
                    stroke: stroke.clone(),
                    display: format!("<{name}>"),
                    token: Some(name),
                }),
                None => {
                    if !parsed.unknown_tokens.contains(&name) {
                        parsed.unknown_tokens.push(name);
                    }
                }
            }
            index = end + 1;
            continue;
        }
        if let Some((part, next)) = modified_part(input, index)? {
            parsed.parts.push(part);
            index = next;
            continue;
        }
        if let Some(name) = named_key(input, index) {
            parsed.parts.push(KeySequencePart { stroke: Stroke::new(&name), display: name.clone(), token: None });
            index += name.len();
            continue;
        }
        parsed.parts.push(string_part(&character.to_string())?);
        index += character.len_utf8();
    }
    Ok(parsed)
}

pub(crate) fn normalize_token(name: &str) -> Result<String, String> {
    let name = name.trim().to_lowercase();
    if name.is_empty() {
        return Err("Invalid keymap token: token cannot be empty".to_owned());
    }
    Ok(name)
}

/// Parses a key that must be one stroke, such as a token's key.
pub(crate) fn parse_single(key: &Key, tokens: &HashMap<String, Stroke>) -> Result<KeySequencePart, String> {
    match key {
        Key::Stroke(stroke) => Ok(KeySequencePart::from_stroke(stroke.normalized()?)),
        Key::Text(text) => {
            let parsed = parse_sequence(text, tokens)?;
            match <[KeySequencePart; 1]>::try_from(parsed.parts) {
                Ok([part]) if parsed.unknown_tokens.is_empty() => Ok(part),
                _ => Err(format!("Invalid key \"{text}\": expected a single key stroke")),
            }
        }
    }
}
