//! OpenTUI Core's input parser conformance table (`packages/core/src/lib/stdin-parser.conformance.json`), which Core
//! and native code read too, run against native code's parser on a Session without a renderer through this crate's
//! events. [`notation`] writes them in the table's notation, Core's names for its events:
//!
//! - Shift is part of a character: Core's Shift+a is `Char('A')` with `SHIFT`, and a typed `A` is `Char('A')`.
//! - Core's "linefeed" is `LineFeed`, "kp1" is `Char('1')` with `keypad`, "clear" is `KeypadBegin`, Shift+Tab is
//!   `BackTab`, and its `meta` flag is Alt or Kitty's own Meta bit (`Modifiers::META`). [`Stroke`] names keys as Core
//!   does.
//! - Focus is an event, not a reply, and unknown sequences are replies, not keys with an empty name.
//! - Core's protocol context is [`Expectations`], as in Core's native adapter: Kitty keyboard flags are
//!   `KITTY_KEYBOARD`, and the replies the host waits for are `REPLIES`, with `CURSOR_POSITION` for a cursor
//!   position report.
//!
//! The other tests check what the table's notation cannot show: where this crate's events differ from Core's, and
//! what only this crate's API has.

use super::{
    ESCAPE_TIMEOUT, Event, Expectations, Input, KeyCode, KeyEvent, KeyEventKind, Modifiers, MouseButton, MouseEvent,
    MouseEventKind, Parser,
};
use crate::keymap::Stroke;
use KeyCode::*;
use KeyEventKind::{Release, Repeat};
use MouseButton as Button;
use MouseEventKind as Mouse;
use std::time::Instant;

const NONE: Modifiers = Modifiers::NONE;
const SHIFT: Modifiers = Modifiers::SHIFT;
const ALT: Modifiers = Modifiers::ALT;
const CTRL: Modifiers = Modifiers::CTRL;

fn parse(bytes: &[u8]) -> Vec<Input> {
    split(&[bytes])
}

/// Parses chunks that all arrive at the same moment.
fn split(chunks: &[&[u8]]) -> Vec<Input> {
    let mut timed = Timed::new();
    chunks.iter().flat_map(|chunk| timed.feed(chunk)).collect()
}

fn key(code: KeyCode, modifiers: Modifiers) -> Input {
    Input::Event(Event::Key(KeyEvent::new(code, modifiers)))
}

fn key_kind(code: KeyCode, modifiers: Modifiers, kind: KeyEventKind) -> Input {
    Input::Event(Event::Key(KeyEvent { code, modifiers, kind, base_layout: None, keypad: false }))
}

/// Parses keys without their keypad flag, which [`core_key_names`] checks.
fn parse_keys(bytes: &[u8]) -> Vec<Input> {
    parse(bytes)
        .into_iter()
        .map(|input| match input {
            Input::Event(Event::Key(key)) => Input::Event(Event::Key(KeyEvent { keypad: false, ..key })),
            other => other,
        })
        .collect()
}

fn ch(character: char) -> Input {
    key(Char(character), NONE)
}

fn mouse(kind: MouseEventKind, x: u16, y: u16, modifiers: Modifiers) -> Input {
    Input::Event(Event::Mouse(MouseEvent { kind, x, y, modifiers }))
}

fn paste(text: &str) -> Input {
    Input::Event(Event::Paste(text.into()))
}

/// A parser driven by a manual clock.
struct Timed {
    parser: Parser,
    now: Instant,
}

impl Timed {
    fn new() -> Self {
        Self::expecting(Expectations::NONE)
    }

    fn expecting(expectations: Expectations) -> Self {
        let (mut parser, now) = (Parser::standalone().unwrap(), Instant::now());
        parser.set_expectations(expectations, now, &mut Vec::new()).unwrap();
        Self { parser, now }
    }

    fn feed(&mut self, bytes: &[u8]) -> Vec<Input> {
        let mut out = Vec::new();
        self.parser.feed(bytes, self.now, &mut out).unwrap();
        out
    }

    /// Lets the timeout pass.
    fn wait(&mut self) -> Vec<Input> {
        self.now += ESCAPE_TIMEOUT;
        let mut out = Vec::new();
        self.parser.expire(self.now, &mut out).unwrap();
        out
    }
}

/// Writes an event in the table's notation (its `format` field). This crate's events keep no encoding, so mouse
/// motion and wheels get SGR's button numbers: X10 motion and wheel reports are checked below instead.
fn notation(input: &Input) -> String {
    let json = |text: &str| serde_json::to_string(text).unwrap();
    let flags = |list: &[(bool, &str)]| -> String {
        list.iter().filter(|(on, _)| *on).map(|(_, name)| format!(" {name}")).collect()
    };
    match input {
        Input::Event(Event::Key(key)) => {
            let modifiers = key.modifiers;
            let alt = modifiers.contains(ALT);
            let stroke = Stroke::from_event(key);
            // Core names a typed uppercase letter by its lowercase key with Shift; Alt keeps the case.
            let (name, shift) = match key.code {
                Char(character) if !key.keypad && character != ' ' => match character {
                    _ if modifiers.contains(SHIFT) => (character.to_lowercase().collect(), true),
                    'A'..='Z' if alt => (character.to_string(), true),
                    'A'..='Z' => (character.to_ascii_lowercase().to_string(), true),
                    _ => (character.to_string(), false),
                },
                _ => (stroke.name, stroke.shift),
            };
            let flags: String = flags(&[
                (stroke.ctrl, "ctrl"),
                (stroke.meta, "meta"),
                (shift, "shift"),
                (stroke.super_, "super"),
                (stroke.hyper, "hyper"),
                (modifiers.contains(Modifiers::CAPS_LOCK), "capslock"),
                (modifiers.contains(Modifiers::NUM_LOCK), "numlock"),
                (key.kind == Release, "release"),
                (key.kind == Repeat, "repeat"),
            ]);
            format!("key({}{flags})", json(&name))
        }
        Input::Event(Event::Mouse(event)) => {
            let number = |button| match button {
                Button::Left => 0,
                Button::Middle => 1,
                Button::Right => 2,
                Button::Other(number) => number,
            };
            let (kind, button) = match event.kind {
                Mouse::Down(button) => ("down", number(button)),
                Mouse::Up(button) => ("up", number(button)),
                Mouse::Drag(button) => ("drag", number(button)),
                Mouse::Moved => ("move", 0),
                Mouse::ScrollUp | Mouse::ScrollRight => ("scroll", 0),
                Mouse::ScrollDown => ("scroll", 1),
                Mouse::ScrollLeft => ("scroll", 2),
            };
            let modifiers = event.modifiers;
            let flags: String = flags(&[
                (modifiers.contains(SHIFT), "shift"),
                (modifiers.contains(ALT), "meta"),
                (modifiers.contains(CTRL), "ctrl"),
            ]);
            format!("mouse({kind} {},{} b{button}{flags})", event.x, event.y)
        }
        Input::Event(Event::Paste(text)) => format!("paste({})", json(text)),
        Input::Event(Event::Focus(gained)) => format!("response({})", json(if *gained { "\x1b[I" } else { "\x1b[O" })),
        Input::Reply(bytes) => {
            format!("response({})", json(&bytes.iter().copied().map(char::from).collect::<String>()))
        }
        other => panic!("the parser reports no {other:?}"),
    }
}

#[test]
fn conformance_vectors() {
    let file: serde_json::Value =
        serde_json::from_str(include_str!("../../../../../core/src/lib/stdin-parser.conformance.json")).unwrap();
    for row in file["rows"].as_array().unwrap() {
        // A step is one read, or None for the timeout passing.
        let steps: Vec<Option<Vec<u8>>> = row[1]
            .as_array()
            .unwrap()
            .iter()
            .map(|step| match step {
                serde_json::Value::Null => None,
                serde_json::Value::String(text) => Some(text.as_bytes().to_vec()),
                bytes => Some(bytes.as_array().unwrap().iter().map(|byte| byte.as_u64().unwrap() as u8).collect()),
            })
            .collect();
        let bytewise: Vec<Option<Vec<u8>>> = steps
            .iter()
            .flat_map(|step| match step {
                Some(bytes) => bytes.iter().map(|&byte| Some(vec![byte])).collect(),
                None => vec![None],
            })
            .collect();
        let mut expectations = Expectations::NONE;
        let context = &row[4];
        if context["kitty"] == true {
            expectations = expectations | Expectations::KITTY_KEYBOARD;
        }
        for query in context["pending"].as_array().into_iter().flatten() {
            expectations = expectations
                | match query.as_str().unwrap() {
                    "cpr" => Expectations::REPLIES | Expectations::CURSOR_POSITION,
                    "pixel" => Expectations::REPLIES,
                    other => panic!("unknown pending query {other}"),
                };
        }
        for steps in [&steps, &bytewise] {
            let mut timed = Timed::expecting(expectations);
            let mut out = Vec::new();
            // After the last step the timeout passes once more.
            for step in steps.iter().chain([&None]) {
                out.extend(match step {
                    Some(bytes) => timed.feed(bytes),
                    None => timed.wait(),
                });
            }
            assert_eq!(out.iter().map(notation).collect::<Vec<_>>(), row[2].as_array().unwrap().clone(), "{}", row[0]);
        }
    }
}

#[test]
fn kitty_keys_carry_their_base_layout_key() {
    let base = |bytes: &[u8]| match &parse(bytes)[..] {
        [Input::Event(Event::Key(key))] => key.base_layout,
        other => panic!("{other:?}"),
    };
    assert_eq!(base(b"\x1b[97:65:113u"), Some('q'));
    assert_eq!(base(b"\x1b[12618::99;5u"), Some('c'));
    // A base key equal to the typed key, or its lowercase form, adds nothing.
    assert_eq!(base(b"\x1b[97:65:97u"), None);
    assert_eq!(base(b"\x1b[97:65:97;2u"), None);
    assert_eq!(base(b"\x1b[57352::57352u"), None);
}

/// Where this crate's events say more than Core's notation: the keys of text with several characters, a character
/// Kitty sends without Shift, the text of a keypad key, Shift on a character, BackTab, Kitty's Meta, a scroll right,
/// X10 motion without a button and X10 wheels, and paste decoding.
#[test]
fn events_that_differ_from_core() {
    let x10 = |code: u8, x: u8, y: u8| [0x1b, b'[', b'M', code + 32, x + 33, y + 33];
    for (bytes, expected) in [
        // Text without a key, such as an input method's, can hold several characters, all of which arrive.
        // Each character is a key with the first one's modifiers and kind.
        (b"\x1b[0;;104:105u".as_slice(), vec![ch('h'), ch('i')]),
        (b"\x1b[0;;97:97:97:97:97:97:97:97:98u", [vec![ch('a'); 8], vec![ch('b')]].concat()),
        (b"\x1b[104;5:2;104:105u", vec![key_kind(Char('h'), CTRL, Repeat), key_kind(Char('i'), CTRL, Repeat)]),
        (b"\x1b[65u", vec![ch('A')]),
        (b"\x1b[90u", vec![ch('Z')]),
        (b"\x1b[97;1;65u", vec![ch('A')]),
        // Core names this kp1; this crate names a keypad key by the text Kitty says it types.
        (b"\x1b[57400;1;120u", vec![ch('x')]),
        // Core names these the same as other keys: Shift applied to a character, Shift+Tab, Kitty's Meta bit apart
        // from Alt, and a scroll right.
        (b"\x1b[27;2;97~", vec![key(Char('A'), SHIFT)]),
        (b"\x1b[97;2u", vec![key(Char('A'), SHIFT)]),
        (b"\x1b[Z", vec![key(BackTab, SHIFT)]),
        (b"\x1b[97;33u", vec![key(Char('a'), Modifiers::META)]),
        (b"\x1b[<67;11;6M", vec![mouse(Mouse::ScrollRight, 10, 5, NONE)]),
        (&x10(35, 4, 5), vec![mouse(Mouse::Moved, 4, 5, NONE)]),
        (&x10(39, 10, 5), vec![mouse(Mouse::Moved, 10, 5, SHIFT)]),
        (&x10(51, 10, 5), vec![mouse(Mouse::Moved, 10, 5, CTRL)]),
        (&x10(63, 10, 5), vec![mouse(Mouse::Moved, 10, 5, SHIFT | ALT | CTRL)]),
        // Motion wins over the wheel bit.
        (&x10(96, 10, 5), vec![mouse(Mouse::Moved, 10, 5, NONE)]),
        (&x10(65, 10, 5), vec![mouse(Mouse::ScrollDown, 10, 5, NONE)]),
        (&x10(66, 10, 5), vec![mouse(Mouse::ScrollLeft, 10, 5, NONE)]),
        // Decoded as Core's `decodePasteBytes`: lossy UTF-8 without a leading byte order mark.
        (b"\x1b[200~\xef\xbb\xbfa\xff\x1b[201~", vec![paste("a\u{fffd}")]),
    ] {
        assert_eq!(parse_keys(bytes), expected, "{}", String::from_utf8_lossy(bytes).escape_debug());
    }
    let payload = "x".repeat(100_000);
    assert_eq!(parse(format!("\x1b[200~{payload}\x1b[201~z").as_bytes()), [paste(&payload), ch('z')]);
    // Native code reports a paste in pieces of the payload buffer's size; joined, it keeps at most 4 MiB.
    for length in [(4 << 20) - 1, 4 << 20, (4 << 20) + 1] {
        let pasted = parse(format!("\x1b[200~{}\x1b[201~", "p".repeat(length)).as_bytes());
        assert!(matches!(&pasted[..], [Input::Event(Event::Paste(text))] if text.len() == length.min(4 << 20)));
    }
    // A paste start cut by a pause continues only into a read that holds the rest of its marker and more, so a table
    // row, which must parse the same one byte at a time, cannot show it.
    let mut timed = Timed::new();
    assert_eq!(timed.feed(b"\x1b[20"), []);
    assert_eq!(timed.wait(), []);
    assert_eq!(timed.feed(b"0~a\rb\x1b[201~"), [paste("a\rb")]);
}

// parse.keypress-kitty.protocol.test.ts

/// Kitty's functional key definitions, `CSI code u`.
fn kitty_functional_keys() -> Vec<(u32, KeyCode)> {
    let mut keys = vec![(27, Escape), (13, Enter), (9, Tab), (127, Backspace)];
    let named = [
        Insert,
        Delete,
        Left,
        Right,
        Up,
        Down,
        PageUp,
        PageDown,
        Home,
        End,
        CapsLock,
        ScrollLock,
        NumLock,
        PrintScreen,
        Pause,
        Menu,
    ];
    keys.extend((57348..).zip(named));
    keys.extend((1..=35).map(|number: u8| (57363 + u32::from(number), F(number))));
    let keypad = "0123456789./*-+".chars().map(Char).chain([
        Enter,
        Char('='),
        Char(','),
        Left,
        Right,
        Up,
        Down,
        PageUp,
        PageDown,
        Home,
        End,
        Insert,
        Delete,
        KeypadBegin,
    ]);
    keys.extend((57399..).zip(keypad));
    // Media, volume, modifier, and ISO level keys.
    keys.extend((57428..=57454).map(|code| (code, Other(code))));
    keys
}

#[test]
fn kitty_protocol_functional_keys() {
    let keys = kitty_functional_keys();
    assert_eq!(keys.len(), 111);
    for (code, expected) in keys {
        assert_eq!(parse_keys(format!("\x1b[{code}u").as_bytes()), [key(expected, NONE)], "{code}");
    }
}

/// Core's key names for bytes whose name is not the key they stand for: a legacy line feed, and Kitty keypad keys.
/// Legacy keypad sequences are the keys they stand for, as in Core.
#[test]
fn core_key_names() {
    let name = |bytes: &[u8]| match &parse(bytes)[..] {
        [Input::Event(Event::Key(key))] => Stroke::from_event(key).to_string(),
        other => panic!("{other:?}"),
    };
    let names = [
        "kp0",
        "kp1",
        "kp2",
        "kp3",
        "kp4",
        "kp5",
        "kp6",
        "kp7",
        "kp8",
        "kp9",
        "kpdecimal",
        "kpdivide",
        "kpmultiply",
        "kpminus",
        "kpplus",
        "kpenter",
        "kpequal",
        "kpseparator",
        "kpleft",
        "kpright",
        "kpup",
        "kpdown",
        "kppageup",
        "kppagedown",
        "kphome",
        "kpend",
        "kpinsert",
        "kpdelete",
        "clear",
    ];
    for (code, expected) in (57399..).zip(names) {
        assert_eq!(name(format!("\x1b[{code}u").as_bytes()), expected, "{code}");
    }
    for (bytes, expected) in [
        (b"\r".as_slice(), "enter"),
        (b"\n", "linefeed"),
        (b"\x1b\r", "meta+enter"),
        (b"\x1b\n", "meta+linefeed"),
        // Kitty reports Enter and Ctrl+J as themselves.
        (b"\x1b[13u", "enter"),
        (b"\x1b[13;5u", "ctrl+enter"),
        (b"\x1b[106;5u", "ctrl+j"),
        (b"\x1b[27;5;13~", "ctrl+enter"),
        // The application keypad.
        (b"\x1bOM", "enter"),
        (b"\x1bOp", "0"),
        (b"\x1bOk", "+"),
        (b"\x1bOX", "="),
        (b"\x1b[57414;3u", "meta+kpenter"),
        (b"\x1b[57400;5u", "ctrl+kp1"),
        (b"\x1b[57419;5u", "ctrl+kpup"),
        (b"\x1b[57427;1:1~", "clear"),
        // Core names this kp1; this crate names a keypad key by the text Kitty says it types.
        (b"\x1b[57400;1;120u", "x"),
        // A typed private-use character is not a keypad key.
        (b"\xee\x80\xb7", "\u{e037}"),
    ] {
        assert_eq!(name(bytes), expected, "{}", String::from_utf8_lossy(bytes).escape_debug());
    }
}
