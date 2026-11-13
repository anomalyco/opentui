//! OpenTUI Core's input parser test vectors, from `parse.keypress*.test.ts`, `parse.mouse.test.ts`, and
//! `stdin-parser.test.ts`, translated to this crate's event model and run against native code's parser on a Session
//! without a renderer:
//!
//! - Shift is part of a character: Core's Shift+a is `Char('A')` with `SHIFT`, and a typed `A` is `Char('A')`.
//! - Core's "linefeed" is `LineFeed`, "kp1" is `Char('1')` with `keypad`, "clear" is `KeypadBegin`, Shift+Tab is
//!   `BackTab`, and its `meta` flag is Alt (Kitty's own Meta bit is `Modifiers::META`). [`Stroke`] names keys as Core
//!   does.
//! - Focus is an event, not a reply, and unknown sequences are replies, not keys with an empty name.
//! - Motion with a button held is a drag, even without an earlier press.
//! - Core's protocol context is [`Expectations`], as in Core's native adapter: Kitty keyboard flags are
//!   `KITTY_KEYBOARD`, and the replies the host waits for are `REPLIES`, with `CURSOR_POSITION` for a cursor
//!   position report.
//! - An Escape inside OSC, DCS, or APC that does not start `ESC \` ends the string and starts a new sequence; Core
//!   keeps reading the string until its timeout.

use super::{
    ESCAPE_TIMEOUT, Event, Expectations, Input, KeyCode, KeyEvent, KeyEventKind, Modifiers, MouseButton, MouseEvent,
    MouseEventKind, Parser,
};
use crate::keymap::Stroke;
use KeyCode::*;
use KeyEventKind::{Press, Release, Repeat};
use MouseButton as Button;
use MouseEventKind as Mouse;
use std::time::{Duration, Instant};

const NONE: Modifiers = Modifiers::NONE;
const SHIFT: Modifiers = Modifiers::SHIFT;
const ALT: Modifiers = Modifiers::ALT;
const CTRL: Modifiers = Modifiers::CTRL;
const SUPER: Modifiers = Modifiers::SUPER;

fn parse(bytes: &[u8]) -> Vec<Input> {
    split(&[bytes])
}

/// Parses chunks that all arrive at the same moment.
fn split(chunks: &[&[u8]]) -> Vec<Input> {
    let mut parser = Parser::standalone().unwrap();
    let mut out = Vec::new();
    let now = Instant::now();
    for chunk in chunks {
        parser.feed(chunk, now, &mut out).unwrap();
    }
    out
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

fn reply(bytes: &[u8]) -> Input {
    Input::Reply(bytes.to_vec())
}

fn paste(text: &str) -> Input {
    Input::Event(Event::Paste(text.into()))
}

fn focus(gained: bool) -> Input {
    Input::Event(Event::Focus(gained))
}

fn check(cases: &[(&[u8], &[Input])]) {
    for (bytes, expected) in cases {
        assert_eq!(parse(bytes), *expected, "{}", String::from_utf8_lossy(bytes).escape_debug());
    }
}

fn check_keys(cases: &[(&[u8], KeyCode, Modifiers)]) {
    for &(bytes, code, modifiers) in cases {
        assert_eq!(parse_keys(bytes), [key(code, modifiers)], "{}", String::from_utf8_lossy(bytes).escape_debug());
    }
}

/// Compares keys without their base-layout key, which Core's vectors do not check.
fn check_kinds(cases: &[(&[u8], KeyCode, Modifiers, KeyEventKind)]) {
    for &(bytes, code, modifiers, kind) in cases {
        let expected = [key_kind(code, modifiers, kind)];
        let parsed: Vec<Input> = parse_keys(bytes)
            .into_iter()
            .map(|input| match input {
                Input::Event(Event::Key(key)) => Input::Event(Event::Key(KeyEvent { base_layout: None, ..key })),
                other => other,
            })
            .collect();
        assert_eq!(parsed, expected, "{}", String::from_utf8_lossy(bytes).escape_debug());
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

/// An X10 mouse report for a button code and zero-based cell.
fn x10(code: u8, x: u8, y: u8) -> [u8; 6] {
    [0x1b, b'[', b'M', code + 32, x + 33, y + 33]
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

    fn wait(&mut self, milliseconds: u64) -> Vec<Input> {
        self.now += Duration::from_millis(milliseconds);
        let mut out = Vec::new();
        self.parser.expire(self.now, &mut out).unwrap();
        out
    }
}

/// Whole input, byte-at-a-time input, and every two-chunk split must parse the same.
fn assert_split_invariant(stream: &[u8]) {
    let expected = parse(stream);
    let bytes: Vec<&[u8]> = stream.chunks(1).collect();
    assert_eq!(split(&bytes), expected, "{}", String::from_utf8_lossy(stream).escape_debug());
    for index in 1..stream.len() {
        let (head, tail) = stream.split_at(index);
        assert_eq!(split(&[head, tail]), expected, "{} at {index}", String::from_utf8_lossy(stream).escape_debug());
    }
}

// parse.keypress.test.ts

#[test]
fn keypress_text_controls_and_alt() {
    check_keys(&[
        (b"a", Char('a'), NONE),
        (b"A", Char('A'), NONE),
        (b"1", Char('1'), NONE),
        (b"!", Char('!'), NONE),
        (b"@", Char('@'), NONE),
        (b" ", Char(' '), NONE),
        ("é".as_bytes(), Char('é'), NONE),
        ("中".as_bytes(), Char('中'), NONE),
        ("👍".as_bytes(), Char('👍'), NONE),
        (b"\r", Enter, NONE),
        (b"\n", LineFeed, NONE),
        (b"\t", Tab, NONE),
        (b"\x08", Backspace, NONE),
        (b"\x7f", Backspace, NONE),
        (b"\x01", Char('a'), CTRL),
        (b"\x1a", Char('z'), CTRL),
        (b"\x07", Char('g'), CTRL),
        (b"\x00", Char(' '), CTRL),
        (b"\x1c", Char('\\'), CTRL),
        (b"\x1d", Char(']'), CTRL),
        (b"\x1e", Char('^'), CTRL),
        (b"\x1f", Char('_'), CTRL),
        (b"\x1b\r", Enter, ALT),
        (b"\x1b\n", LineFeed, ALT),
        (b"\x1b ", Char(' '), ALT),
        (b"\x1ba", Char('a'), ALT),
        (b"\x1bA", Char('A'), ALT),
        (b"\x1bU", Char('U'), ALT),
        (b"\x1bN", Char('N'), ALT),
        (b"\x1bf", Char('f'), ALT),
        (b"\x1bb", Char('b'), ALT),
        (b"\x1b\x01", Char('a'), CTRL | ALT),
        (b"\x1b\x15", Char('u'), CTRL | ALT),
        (b"\x1b\x1a", Char('z'), CTRL | ALT),
        (b"\x1b\x1c", Char('\\'), CTRL | ALT),
        (b"\x1b\x1d", Char(']'), CTRL | ALT),
        (b"\x1b\x1e", Char('^'), CTRL | ALT),
        (b"\x1b\x1f", Char('_'), CTRL | ALT),
        // Old-style Alt+arrow forms. Core's `ESC P` vector is a DCS introducer to its stream parser and to this one.
        (b"\x1bF", Right, ALT),
        (b"\x1bB", Left, ALT),
        // An eight-bit Alt+Space: 160 is 128 + ' '.
        (b"\xa0", Char(' '), ALT),
        // Private-use characters that share their scalar with a Kitty functional or keypad key's code.
        (b"\xee\x80\x80", Char('\u{e000}'), NONE),
        (b"\xee\x80\x84", Char('\u{e004}'), NONE),
        (b"\xee\x80\xa0", Char('\u{e020}'), NONE),
        (b"\xee\x81\xae", Char('\u{e06e}'), NONE),
        (b"\x1b\xee\x80\x80", Char('\u{e000}'), ALT),
        (b"\x1b\xee\x80\x84", Char('\u{e004}'), ALT),
        (b"\x1b\xee\x80\xb7", Char('\u{e037}'), ALT),
        (b"\x1b\xee\x81\x88", Char('\u{e048}'), ALT),
    ]);
}

#[test]
fn keypress_escape_forms_wait_for_the_timeout() {
    let mut timed = Timed::new();
    assert_eq!(timed.feed(b"\x1b"), []);
    assert_eq!(timed.wait(20), [key(Escape, NONE)]);
    assert_eq!(timed.feed(b"\x1b\x1b"), []);
    assert_eq!(timed.wait(20), [key(Escape, ALT)]);
}

#[test]
fn keypress_legacy_sequences() {
    check_keys(&[
        (b"\x1bOP", F(1), NONE),
        (b"\x1b[11~", F(1), NONE),
        (b"\x1b[24~", F(12), NONE),
        (b"\x1b[A", Up, NONE),
        (b"\x1b[B", Down, NONE),
        (b"\x1b[C", Right, NONE),
        (b"\x1b[D", Left, NONE),
        (b"\x1b[H", Home, NONE),
        (b"\x1b[F", End, NONE),
        (b"\x1b[2~", Insert, NONE),
        (b"\x1b[5~", PageUp, NONE),
        (b"\x1b[6~", PageDown, NONE),
        (b"\x1bOA", Up, NONE),
        (b"\x1bOB", Down, NONE),
        // Modifier bits: Shift 1, Alt 2, Ctrl 4, Super 8.
        (b"\x1b[1;2A", Up, SHIFT),
        (b"\x1b[1;3A", Up, ALT),
        (b"\x1b[1;4A", Up, SHIFT | ALT),
        (b"\x1b[1;5A", Up, CTRL),
        (b"\x1b[1;7A", Up, CTRL | ALT),
        (b"\x1b[1;8A", Up, SHIFT | ALT | CTRL),
        (b"\x1b[1;9A", Up, SUPER),
        (b"\x1b[1;10A", Up, SHIFT | SUPER),
        (b"\x1b[1;11A", Up, ALT | SUPER),
        (b"\x1b[1;13A", Up, CTRL | SUPER),
        (b"\x1b[1;16A", Up, SHIFT | ALT | CTRL | SUPER),
        (b"\x1b[1;3C", Right, ALT),
        (b"\x1b[1;9C", Right, SUPER),
        (b"\x1b[1;11C", Right, ALT | SUPER),
        (b"\x1b[3~", Delete, NONE),
        (b"\x1b[3;2~", Delete, SHIFT),
        (b"\x1b[3;3~", Delete, ALT),
        (b"\x1b[3;5~", Delete, CTRL),
        (b"\x1b[3;4~", Delete, SHIFT | ALT),
        (b"\x1b[3;7~", Delete, CTRL | ALT),
        (b"\x1b[11;5~", F(1), CTRL),
        (b"\x1b[11;3~", F(1), ALT),
        (b"\x1b[11;9~", F(1), SUPER),
        (b"\x1b[11;6~", F(1), SHIFT | CTRL),
        // rxvt: lowercase CSI letters and `$` mean Shift, lowercase SS3 letters and `^` mean Ctrl.
        (b"\x1b[a", Up, SHIFT),
        (b"\x1b[2$", Insert, SHIFT),
        (b"\x1bOa", Up, CTRL),
        (b"\x1b[2^", Insert, CTRL),
        // Two Escapes are Alt with the key sequence after them.
        (b"\x1b\x1b[A", Up, ALT),
        (b"\x1b\x1b[1;5A", Up, CTRL | ALT),
        // The application keypad.
        (b"\x1bOM", Enter, NONE),
        (b"\x1bOp", Char('0'), NONE),
        (b"\x1bOq", Char('1'), NONE),
        (b"\x1bOr", Char('2'), NONE),
        (b"\x1bOs", Char('3'), NONE),
        (b"\x1bOt", Char('4'), NONE),
        (b"\x1bOu", Char('5'), NONE),
        (b"\x1bOv", Char('6'), NONE),
        (b"\x1bOw", Char('7'), NONE),
        (b"\x1bOx", Char('8'), NONE),
        (b"\x1bOy", Char('9'), NONE),
        (b"\x1bOj", Char('*'), NONE),
        (b"\x1bOk", Char('+'), NONE),
        (b"\x1bOl", Char(','), NONE),
        (b"\x1bOm", Char('-'), NONE),
        (b"\x1bOn", Char('.'), NONE),
        (b"\x1bOo", Char('/'), NONE),
        (b"\x1bOX", Char('='), NONE),
    ]);
}

#[test]
fn keypress_modify_other_keys_and_kitty() {
    check_keys(&[
        (b"\x1b[27;2;49~", Char('1'), SHIFT),
        (b"\x1b[27;2;97~", Char('A'), SHIFT),
        (b"\x1b[27;2;13~", Enter, SHIFT),
        (b"\x1b[27;5;13~", Enter, CTRL),
        (b"\x1b[27;3;13~", Enter, ALT),
        (b"\x1b[27;6;13~", Enter, SHIFT | CTRL),
        (b"\x1b[27;4;13~", Enter, SHIFT | ALT),
        (b"\x1b[27;7;13~", Enter, CTRL | ALT),
        (b"\x1b[27;8;13~", Enter, SHIFT | CTRL | ALT),
        (b"\x1b[27;5;27~", Escape, CTRL),
        (b"\x1b[27;2;27~", Escape, SHIFT),
        (b"\x1b[27;3;27~", Escape, ALT),
        (b"\x1b[27;6;27~", Escape, SHIFT | CTRL),
        (b"\x1b[27;5;9~", Tab, CTRL),
        (b"\x1b[27;2;9~", BackTab, SHIFT),
        (b"\x1b[27;5;32~", Char(' '), CTRL),
        (b"\x1b[27;2;32~", Char(' '), SHIFT),
        (b"\x1b[27;3;32~", Char(' '), ALT),
        (b"\x1b[27;2;127~", Backspace, SHIFT),
        (b"\x1b[27;5;127~", Backspace, CTRL),
        (b"\x1b[27;3;127~", Backspace, ALT),
        (b"\x1b[27;5;8~", Backspace, CTRL),
        // A code past Backspace is a character, though Kitty numbers Insert and keypad 0 the same.
        (b"\x1b[27;5;57348~", Char('\u{e004}'), CTRL),
        (b"\x1b[27;5;57399~", Char('\u{e037}'), CTRL),
        (b"\x1b[57349u", Delete, NONE),
        (b"\x1b[57349;2u", Delete, SHIFT),
        (b"\x1b[57349;3u", Delete, ALT),
        (b"\x1b[57349;5u", Delete, CTRL),
        (b"\x1b[127;5u", Backspace, CTRL),
        (b"\x1b[127;3u", Backspace, ALT),
        (b"\x1b[127;2u", Backspace, SHIFT),
        (b"\x1b[97u", Char('a'), NONE),
        (b"\x1b[57352u", Up, NONE),
        (b"\x1b[57364u", F(1), NONE),
        (b"\x1b[97;5u", Char('a'), CTRL),
    ]);
}

#[test]
fn keypress_replies_focus_and_mouse_are_not_keys() {
    for bytes in [
        b"\x1b[4;1782;3012t".as_slice(),
        b"\x1b[4;800;600t",
        b"\x1b[8;24;80t",
        b"\x1b[10;25R",
        b"\x1b[1;1R",
        b"\x1b[?1;2c",
        b"\x1b[?62;c",
        b"\x1b[?1;0;6;9;15c",
        b"\x1b[>41;1;0c",
        b"\x1b[?1;2$y",
        b"\x1b[?25;1$y",
        b"\x1b]11;rgb:0000/0000/0000\x1b\\",
        b"\x1b]10;rgb:ffff/ffff/ffff\x07",
        b"\x1b[201~",
    ] {
        assert_eq!(parse(bytes), [reply(bytes)], "{}", String::from_utf8_lossy(bytes).escape_debug());
    }
    check(&[
        (b"\x1b[I", &[focus(true)]),
        (b"\x1b[O", &[focus(false)]),
        // Incomplete strings, paste starts, and partial mouse reports wait for more input.
        (b"\x1b]11;rgb:0000", &[]),
        (b"\x1b[200~", &[]),
        (b"\x1b[<35;", &[]),
        (b"\x1b[<35;20", &[]),
        (b"\x1b[<35;20;", &[]),
        (b"\x1b[<35;20;5", &[]),
        (b"\x1b[<", &[]),
        (b"\x1b[<0", &[]),
        (b"\x1b[<64;20;10", &[]),
        (b"\x1b[<0;10;5M", &[mouse(Mouse::Down(Button::Left), 9, 4, NONE)]),
        (b"\x1b[<0;10;5m", &[mouse(Mouse::Up(Button::Left), 9, 4, NONE)]),
        (b"\x1b[<32;15;8M", &[mouse(Mouse::Drag(Button::Left), 14, 7, NONE)]),
        (b"\x1b[<64;20;10M", &[mouse(Mouse::ScrollUp, 19, 9, NONE)]),
        (b"\x1b[M abc", &[mouse(Mouse::Down(Button::Left), 64, 65, NONE), ch('c')]),
    ]);
}

#[test]
fn keypress_events_are_presses() {
    for bytes in [
        b"a".as_slice(),
        b"A",
        b"1",
        b"!",
        b"\t",
        b"\r",
        b"\n",
        b" ",
        b"\x1b",
        b"\x01",
        b"\x1ba",
        b"\x1b[A",
        b"\x1b[11~",
        b"\x1b[1;2A",
        b"\x1b[3~",
        b"x",
    ] {
        let mut timed = Timed::new();
        let mut out = timed.feed(bytes);
        out.extend(timed.wait(20));
        assert!(
            matches!(&out[..], [Input::Event(Event::Key(KeyEvent { kind: Press, .. }))]),
            "{}: {out:?}",
            String::from_utf8_lossy(bytes).escape_debug()
        );
    }
}

// parse.keypress-kitty.test.ts

#[test]
fn kitty_keys_events_and_text() {
    let caps = Modifiers::CAPS_LOCK;
    let num = Modifiers::NUM_LOCK;
    check_kinds(&[
        (b"\x1b[97u", Char('a'), NONE, Press),
        (b"\x1b[97:65;2u", Char('A'), SHIFT, Press),
        (b"\x1b[97;5u", Char('a'), CTRL, Press),
        (b"\x1b[97;3u", Char('a'), ALT, Press),
        (b"\x1b[57364u", F(1), NONE, Press),
        (b"\x1b[57352u", Up, NONE, Press),
        (b"\x1b[32;2u", Char(' '), SHIFT, Press),
        (b"\x1b[32;5u", Char(' '), CTRL, Press),
        (b"\x1b[97;1:1u", Char('a'), NONE, Press),
        (b"\x1b[97;1:2u", Char('a'), NONE, Repeat),
        (b"\x1b[97;1:3u", Char('a'), NONE, Release),
        (b"\x1b[97;5:2u", Char('a'), CTRL, Repeat),
        (b"\x1b[97;2:3u", Char('A'), SHIFT, Release),
        (b"\x1b[97;1:9u", Char('a'), NONE, Press),
        (b"\x1b[97;1:u", Char('a'), NONE, Press),
        (b"\x1b[97;1;97u", Char('a'), NONE, Press),
        (b"\x1b[97;6u", Char('A'), CTRL | SHIFT, Press),
        (b"\x1b[97;4u", Char('A'), ALT | SHIFT, Press),
        (b"\x1b[97;9u", Char('a'), SUPER, Press),
        (b"\x1b[97;17u", Char('a'), Modifiers::HYPER, Press),
        // The shifted and base-layout codepoints only matter with Shift.
        (b"\x1b[97:65u", Char('a'), NONE, Press),
        (b"\x1b[97:65:97u", Char('a'), NONE, Press),
        (b"\x1b[97:65:113u", Char('a'), NONE, Press),
        (b"\x1b[97;65u", Char('a'), caps, Press),
        (b"\x1b[97;129u", Char('a'), num, Press),
        (b"\x1b[57358u", CapsLock, NONE, Press),
        (b"\x1b[57359u", ScrollLock, NONE, Press),
        (b"\x1b[57360u", NumLock, NONE, Press),
        (b"\x1b[233u", Char('é'), NONE, Press),
        (b"\x1b[128512u", Char('😀'), NONE, Press),
        (b"\x1b[57399u", Char('0'), NONE, Press),
        (b"\x1b[57400u", Char('1'), NONE, Press),
        (b"\x1b[57401u", Char('2'), NONE, Press),
        (b"\x1b[57402u", Char('3'), NONE, Press),
        (b"\x1b[57403u", Char('4'), NONE, Press),
        (b"\x1b[57404u", Char('5'), NONE, Press),
        (b"\x1b[57405u", Char('6'), NONE, Press),
        (b"\x1b[57406u", Char('7'), NONE, Press),
        (b"\x1b[57407u", Char('8'), NONE, Press),
        (b"\x1b[57408u", Char('9'), NONE, Press),
        (b"\x1b[57409u", Char('.'), NONE, Press),
        (b"\x1b[57410u", Char('/'), NONE, Press),
        (b"\x1b[57411u", Char('*'), NONE, Press),
        (b"\x1b[57412u", Char('-'), NONE, Press),
        (b"\x1b[57413u", Char('+'), NONE, Press),
        (b"\x1b[57415u", Char('='), NONE, Press),
        (b"\x1b[57416u", Char(','), NONE, Press),
        (b"\x1b[57414u", Enter, NONE, Press),
        (b"\x1b[57400;5u", Char('1'), CTRL, Press),
        (b"\x1b[57400;1;120u", Char('x'), NONE, Press),
        (b"\x1b[57417u", Left, NONE, Press),
        (b"\x1b[57428u", Other(57428), NONE, Press),
        (b"\x1b[57439u", Other(57439), NONE, Press),
        (b"\x1b[57441u", Other(57441), NONE, Press),
        (b"\x1b[57448u", Other(57448), NONE, Press),
        (b"\x1b[57364;1:2u", F(1), NONE, Repeat),
        (b"\x1b[57364;1:3u", F(1), NONE, Release),
        (b"\x1b[57352;5:2u", Up, CTRL, Repeat),
        (b"\x1b[57353;1:3u", Down, NONE, Release),
        (b"\x1b[1;1:1A", Up, NONE, Press),
        (b"\x1b[1;1:3A", Up, NONE, Release),
        (b"\x1b[1;1:2B", Down, NONE, Repeat),
        (b"\x1b[1;1:1D", Left, NONE, Press),
        (b"\x1b[1;1:3C", Right, NONE, Release),
        (b"\x1b[1;2:1A", Up, SHIFT, Press),
        (b"\x1b[1;5:3B", Down, CTRL, Release),
        (b"\x1b[5;1:1~", PageUp, NONE, Press),
        (b"\x1b[5;1:2~", PageUp, NONE, Repeat),
        (b"\x1b[5;1:3~", PageUp, NONE, Release),
        (b"\x1b[6;1:2~", PageDown, NONE, Repeat),
        (b"\x1b[2;2:1~", Insert, SHIFT, Press),
        (b"\x1b[3;5:1~", Delete, CTRL, Press),
        (b"\x1b[1;1:1~", Home, NONE, Press),
        (b"\x1b[4;1:3~", End, NONE, Release),
        (b"\x1b[15;1:1~", F(5), NONE, Press),
        (b"\x1b[24;1:2~", F(12), NONE, Repeat),
        (b"\x1b[1;2:2A", Up, SHIFT, Repeat),
        (b"\x1b[3;5:3~", Delete, CTRL, Release),
        (b"\x1b[1;2A", Up, SHIFT, Press),
        (b"\x1b[97:65:113;5:2;97u", Char('a'), CTRL, Repeat),
        (b"\x1b[97;2u", Char('A'), SHIFT, Press),
        (b"\x1b[1072;2u", Char('А'), SHIFT, Press),
    ]);
    for character in ['a', 'z', 'A', 'Z', '0', '9'] {
        assert_eq!(parse(format!("\x1b[{}u", u32::from(character)).as_bytes()), [ch(character)]);
    }
    // Not a Unicode scalar value.
    assert_eq!(parse(b"\x1b[1114112u"), [reply(b"\x1b[1114112u")]);
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

#[test]
fn kitty_protocol_aliases() {
    check_keys(&[
        (b"\x1b[A", Up, NONE),
        (b"\x1b[B", Down, NONE),
        (b"\x1b[C", Right, NONE),
        (b"\x1b[D", Left, NONE),
        (b"\x1b[E", KeypadBegin, NONE),
        (b"\x1b[F", End, NONE),
        (b"\x1b[H", Home, NONE),
        (b"\x1bOP", F(1), NONE),
        (b"\x1bOQ", F(2), NONE),
        (b"\x1bOR", F(3), NONE),
        (b"\x1bOS", F(4), NONE),
        (b"\x1b[2~", Insert, NONE),
        (b"\x1b[3~", Delete, NONE),
        (b"\x1b[5~", PageUp, NONE),
        (b"\x1b[6~", PageDown, NONE),
        (b"\x1b[7~", Home, NONE),
        (b"\x1b[8~", End, NONE),
        (b"\x1b[11~", F(1), NONE),
        (b"\x1b[12~", F(2), NONE),
        (b"\x1b[13~", F(3), NONE),
        (b"\x1b[14~", F(4), NONE),
        (b"\x1b[15~", F(5), NONE),
        (b"\x1b[17~", F(6), NONE),
        (b"\x1b[18~", F(7), NONE),
        (b"\x1b[19~", F(8), NONE),
        (b"\x1b[20~", F(9), NONE),
        (b"\x1b[21~", F(10), NONE),
        (b"\x1b[23~", F(11), NONE),
        (b"\x1b[24~", F(12), NONE),
        (b"\x1b[29~", Menu, NONE),
        (b"\x1b[57427~", KeypadBegin, NONE),
        (b"\x1b[1;1:1A", Up, NONE),
        (b"\x1b[1;1:1B", Down, NONE),
        (b"\x1b[1;1:1C", Right, NONE),
        (b"\x1b[1;1:1D", Left, NONE),
        (b"\x1b[1;1:1E", KeypadBegin, NONE),
        (b"\x1b[1;1:1F", End, NONE),
        (b"\x1b[1;1:1H", Home, NONE),
        (b"\x1b[1;1:1P", F(1), NONE),
        (b"\x1b[1;1:1Q", F(2), NONE),
        (b"\x1b[1;1:1S", F(4), NONE),
        (b"\x1b[P", F(1), NONE),
        (b"\x1b[Q", F(2), NONE),
        (b"\x1b[S", F(4), NONE),
        (b"\x1b[1;2P", F(1), SHIFT),
        (b"\x1b[1;5Q", F(2), CTRL),
        (b"\x1b[1;3S", F(4), ALT),
        (b"\x1b[2;1:1~", Insert, NONE),
        (b"\x1b[3;1:1~", Delete, NONE),
        (b"\x1b[5;1:1~", PageUp, NONE),
        (b"\x1b[6;1:1~", PageDown, NONE),
        (b"\x1b[7;1:1~", Home, NONE),
        (b"\x1b[8;1:1~", End, NONE),
        (b"\x1b[11;1:1~", F(1), NONE),
        (b"\x1b[12;1:1~", F(2), NONE),
        (b"\x1b[13;1:1~", F(3), NONE),
        (b"\x1b[14;1:1~", F(4), NONE),
        (b"\x1b[15;1:1~", F(5), NONE),
        (b"\x1b[17;1:1~", F(6), NONE),
        (b"\x1b[18;1:1~", F(7), NONE),
        (b"\x1b[19;1:1~", F(8), NONE),
        (b"\x1b[20;1:1~", F(9), NONE),
        (b"\x1b[21;1:1~", F(10), NONE),
        (b"\x1b[23;1:1~", F(11), NONE),
        (b"\x1b[24;1:1~", F(12), NONE),
        (b"\x1b[29;1:1~", Menu, NONE),
        (b"\x1b[57427;1:1~", KeypadBegin, NONE),
    ]);
    // Cursor position reports share `CSI R` and `CSI 1;N R` with F3. As in Core's conformance vectors, these are F3
    // unless the Kitty protocol is on, which sends F3 as `CSI 13 ~`, or the host expects a cursor position report.
    check(&[(b"\x1b[1;1:1R", &[reply(b"\x1b[1;1:1R")])]);
    for (expectations, bytes, expected) in [
        (Expectations::NONE, b"\x1b[R".as_slice(), key(F(3), NONE)),
        (Expectations::NONE, b"\x1b[;5R", reply(b"\x1b[;5R")),
        (Expectations::CURSOR_POSITION, b"\x1b[R", key(F(3), NONE)),
        (Expectations::KITTY_KEYBOARD, b"\x1b[R", reply(b"\x1b[R")),
        (Expectations::KITTY_KEYBOARD, b"\x1b[1;2R", reply(b"\x1b[1;2R")),
        (Expectations::CURSOR_POSITION, b"\x1b[1;2R", reply(b"\x1b[1;2R")),
    ] {
        let parsed = Timed::expecting(expectations).feed(bytes);
        assert_eq!(parsed, [expected], "{}", String::from_utf8_lossy(bytes).escape_debug());
    }
}

#[test]
fn kitty_protocol_modifiers_and_payloads() {
    check_keys(&[
        (b"\x1b[97;2u", Char('A'), SHIFT),
        (b"\x1b[97;3u", Char('a'), ALT),
        (b"\x1b[97;5u", Char('a'), CTRL),
        (b"\x1b[97;9u", Char('a'), SUPER),
        (b"\x1b[97;17u", Char('a'), Modifiers::HYPER),
        (b"\x1b[97;33u", Char('a'), Modifiers::META),
        (b"\x1b[97;65u", Char('a'), Modifiers::CAPS_LOCK),
        (b"\x1b[97;129u", Char('a'), Modifiers::NUM_LOCK),
        (b"\x1b[97;256u", Char('A'), Modifiers::from_bits(255)),
        (b"\x1b[9;2u", BackTab, SHIFT),
        (b"\x1b[57419;5u", Up, CTRL),
    ]);
    check_kinds(&[
        (b"\x1b[32u", Char(' '), NONE, Press),
        (b"\x1b[32;2u", Char(' '), SHIFT, Press),
        (b"\x1b[32;5u", Char(' '), CTRL, Press),
        (b"\x1b[32:32:32;5u", Char(' '), CTRL, Press),
        (b"\x1b[97;1:1u", Char('a'), NONE, Press),
        (b"\x1b[97;1:2u", Char('a'), NONE, Repeat),
        (b"\x1b[97;1:3u", Char('a'), NONE, Release),
        (b"\x1b[97:65u", Char('a'), NONE, Press),
        (b"\x1b[97:65;2u", Char('A'), SHIFT, Press),
        (b"\x1b[97::113u", Char('a'), NONE, Press),
        (b"\x1b[97;1;65u", Char('A'), NONE, Press),
        (b"\x1b[57400u", Char('1'), NONE, Press),
        (b"\x1b[57413u", Char('+'), NONE, Press),
        (b"\x1b[57400;1;120u", Char('x'), NONE, Press),
        (b"\x1b[0;;229u", Char('å'), NONE, Press),
    ]);
    // Text without a key, such as an input method's, can hold several characters, all of which arrive.
    // Each character is a key with the first one's modifiers and kind.
    check(&[
        (b"\x1b[0;;104:105u", &[ch('h'), ch('i')]),
        (b"\x1b[0;;97:97:97:97:97:97:97:97:98u", &[vec![ch('a'); 8], vec![ch('b')]].concat()),
        (b"\x1b[104;5:2;104:105u", &[key_kind(Char('h'), CTRL, Repeat), key_kind(Char('i'), CTRL, Repeat)]),
    ]);
}

// parse.mouse.test.ts

#[test]
fn mouse_x10_reports() {
    let all = SHIFT | ALT | CTRL;
    for (code, kind, modifiers) in [
        (0, Mouse::Down(Button::Left), NONE),
        (1, Mouse::Down(Button::Middle), NONE),
        (2, Mouse::Down(Button::Right), NONE),
        (3, Mouse::Up(Button::Left), NONE),
        (64, Mouse::ScrollUp, NONE),
        (65, Mouse::ScrollDown, NONE),
        (66, Mouse::ScrollLeft, NONE),
        (67, Mouse::ScrollRight, NONE),
        (68, Mouse::ScrollUp, SHIFT),
        (80, Mouse::ScrollUp, CTRL),
        (4, Mouse::Down(Button::Left), SHIFT),
        (8, Mouse::Down(Button::Left), ALT),
        (16, Mouse::Down(Button::Left), CTRL),
        (28, Mouse::Down(Button::Left), all),
        (18, Mouse::Down(Button::Right), CTRL),
        // Core reports motion as a move that its renderer turns into a drag; this parser reports the drag.
        (32, Mouse::Drag(Button::Left), NONE),
        (33, Mouse::Drag(Button::Middle), NONE),
        (34, Mouse::Drag(Button::Right), NONE),
        (35, Mouse::Moved, NONE),
        (39, Mouse::Moved, SHIFT),
        (51, Mouse::Moved, CTRL),
        (63, Mouse::Moved, all),
        // Motion wins over the wheel bit.
        (96, Mouse::Moved, NONE),
    ] {
        assert_eq!(parse(&x10(code, 10, 5)), [mouse(kind, 10, 5, modifiers)], "{code}");
    }
    // Coordinates past 94 are raw bytes above 127, and xterm sends 0 for one past its limit.
    for (x, y) in [(0, 0), (79, 23), (94, 94), (95, 0), (222, 1)] {
        assert_eq!(parse(&x10(0, x, y)), [mouse(Mouse::Down(Button::Left), x.into(), y.into(), NONE)]);
    }
    check(&[
        (b"\x1b[M\x20\x00\x00", &[mouse(Mouse::Down(Button::Left), 223, 223, NONE)]),
        (b"\x1b[M\x20\x21", &[]),
        (b"", &[]),
        (b"\x1b[A", &[key(Up, NONE)]),
        (b"\x1b[1;2R", &[key(F(3), SHIFT)]),
        (b"\x1b[M !!x", &[mouse(Mouse::Down(Button::Left), 0, 0, NONE), ch('x')]),
        // A release reports the button pressed last.
        (
            b"\x1b[M\"!!\x1b[M#!!",
            &[mouse(Mouse::Down(Button::Right), 0, 0, NONE), mouse(Mouse::Up(Button::Right), 0, 0, NONE)],
        ),
        // A control byte cuts the report short.
        (b"\x1b[M \x1b[A", &[reply(b"\x1b[M "), key(Up, NONE)]),
    ]);
    let both = [x10(0, 10, 5), x10(3, 10, 5)].concat();
    assert_eq!(
        parse(&both),
        [mouse(Mouse::Down(Button::Left), 10, 5, NONE), mouse(Mouse::Up(Button::Left), 10, 5, NONE)]
    );
    assert_eq!(split(&[b"\x1b[M", b" !!"]), [mouse(Mouse::Down(Button::Left), 0, 0, NONE)]);
}

#[test]
fn mouse_sgr_reports() {
    let all = SHIFT | ALT | CTRL;
    let cases: &[(&[u8], MouseEventKind, u16, u16, Modifiers)] = &[
        (b"\x1b[<0;11;6M", Mouse::Down(Button::Left), 10, 5, NONE),
        (b"\x1b[<0;11;6m", Mouse::Up(Button::Left), 10, 5, NONE),
        (b"\x1b[<1;11;6M", Mouse::Down(Button::Middle), 10, 5, NONE),
        (b"\x1b[<2;11;6M", Mouse::Down(Button::Right), 10, 5, NONE),
        (b"\x1b[<2;11;6m", Mouse::Up(Button::Right), 10, 5, NONE),
        (b"\x1b[<64;11;6M", Mouse::ScrollUp, 10, 5, NONE),
        (b"\x1b[<65;11;6M", Mouse::ScrollDown, 10, 5, NONE),
        (b"\x1b[<66;11;6M", Mouse::ScrollLeft, 10, 5, NONE),
        (b"\x1b[<67;11;6M", Mouse::ScrollRight, 10, 5, NONE),
        // URxvt sets the wheel bit on motion.
        (b"\x1b[<96;81;67M", Mouse::Moved, 80, 66, NONE),
        (b"\x1b[<97;81;67M", Mouse::Moved, 80, 66, NONE),
        (b"\x1b[<35;11;6m", Mouse::Moved, 10, 5, NONE),
        (b"\x1b[<32;13;6m", Mouse::Drag(Button::Left), 12, 5, NONE),
        (b"\x1b[<4;11;6M", Mouse::Down(Button::Left), 10, 5, SHIFT),
        (b"\x1b[<8;11;6M", Mouse::Down(Button::Left), 10, 5, ALT),
        (b"\x1b[<16;11;6M", Mouse::Down(Button::Left), 10, 5, CTRL),
        (b"\x1b[<28;11;6M", Mouse::Down(Button::Left), 10, 5, all),
        (b"\x1b[<0;1;1M", Mouse::Down(Button::Left), 0, 0, NONE),
        (b"\x1b[<0;501;301M", Mouse::Down(Button::Left), 500, 300, NONE),
        // Extra buttons: 128 + 1 is button 9.
        (b"\x1b[<129;1;1M", Mouse::Down(Button::Other(9)), 0, 0, NONE),
    ];
    for &(bytes, kind, x, y, modifiers) in cases {
        assert_eq!(parse(bytes), [mouse(kind, x, y, modifiers)], "{}", String::from_utf8_lossy(bytes).escape_debug());
    }
    check(&[
        // A wheel release carries nothing, and an incomplete report waits.
        (b"\x1b[<64;11;6m", &[reply(b"\x1b[<64;11;6m")]),
        (b"\x1b[<0;1;1", &[]),
        (
            b"\x1b[<0;6;6M\x1b[<32;9;6m",
            &[mouse(Mouse::Down(Button::Left), 5, 5, NONE), mouse(Mouse::Drag(Button::Left), 8, 5, NONE)],
        ),
        (
            b"\x1b[<0;6;6M\x1b[<32;9;6m\x1b[<0;9;6m\x1b[<35;11;6m",
            &[
                mouse(Mouse::Down(Button::Left), 5, 5, NONE),
                mouse(Mouse::Drag(Button::Left), 8, 5, NONE),
                mouse(Mouse::Up(Button::Left), 8, 5, NONE),
                mouse(Mouse::Moved, 10, 5, NONE),
            ],
        ),
        (
            b"\x1b[<0;6;6M\x1b[<2;6;6M\x1b[<2;6;6m\x1b[<32;9;6m",
            &[
                mouse(Mouse::Down(Button::Left), 5, 5, NONE),
                mouse(Mouse::Down(Button::Right), 5, 5, NONE),
                mouse(Mouse::Up(Button::Right), 5, 5, NONE),
                mouse(Mouse::Drag(Button::Left), 8, 5, NONE),
            ],
        ),
    ]);
}

#[test]
fn mouse_reports_in_one_chunk() {
    check(&[
        (b"\x1b[<0;11;6M", &[mouse(Mouse::Down(Button::Left), 10, 5, NONE)]),
        (
            b"\x1b[<32;70;50M\x1b[<32;69;50M",
            &[mouse(Mouse::Drag(Button::Left), 69, 49, NONE), mouse(Mouse::Drag(Button::Left), 68, 49, NONE)],
        ),
        (
            b"\x1b[<32;70;50M\x1b[<32;69;50M\x1b[<32;69;49M\x1b[<32;68;49M",
            &[
                mouse(Mouse::Drag(Button::Left), 69, 49, NONE),
                mouse(Mouse::Drag(Button::Left), 68, 49, NONE),
                mouse(Mouse::Drag(Button::Left), 68, 48, NONE),
                mouse(Mouse::Drag(Button::Left), 67, 48, NONE),
            ],
        ),
        (
            b"\x1b[<0;11;11M\x1b[<32;13;11M\x1b[<0;13;11m",
            &[
                mouse(Mouse::Down(Button::Left), 10, 10, NONE),
                mouse(Mouse::Drag(Button::Left), 12, 10, NONE),
                mouse(Mouse::Up(Button::Left), 12, 10, NONE),
            ],
        ),
        (
            b"\x1b[<64;83;68M\x1b[<64;83;68M\x1b[<65;83;68M",
            &[
                mouse(Mouse::ScrollUp, 82, 67, NONE),
                mouse(Mouse::ScrollUp, 82, 67, NONE),
                mouse(Mouse::ScrollDown, 82, 67, NONE),
            ],
        ),
        (
            b"\x1b[<64;83;68M\x1b[<96;82;68M\x1b[<97;81;68M",
            &[
                mouse(Mouse::ScrollUp, 82, 67, NONE),
                mouse(Mouse::Moved, 81, 67, NONE),
                mouse(Mouse::Moved, 80, 67, NONE),
            ],
        ),
        (
            b"\x1b[<0;6;6M\x1b[<32;9;6M",
            &[mouse(Mouse::Down(Button::Left), 5, 5, NONE), mouse(Mouse::Drag(Button::Left), 8, 5, NONE)],
        ),
    ]);
}

// stdin-parser.test.ts

#[test]
fn stream_printable_ascii_and_controls() {
    let text = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789!@#$%^&*()-_=+[]{}|;':,./<>?`~ ";
    assert_eq!(parse(text.as_bytes()), text.chars().map(ch).collect::<Vec<_>>());
    for byte in (0..=0x1au8).chain([0x7f]) {
        let expected = match byte {
            0x00 => key(Char(' '), CTRL),
            0x08 | 0x7f => key(Backspace, NONE),
            0x09 => key(Tab, NONE),
            0x0a => key(LineFeed, NONE),
            0x0d => key(Enter, NONE),
            _ => key(Char(char::from(b'a' + byte - 1)), CTRL),
        };
        assert_eq!(parse(&[byte]), [expected], "{byte:#04x}");
    }
    check(&[(b"\x1b[Z", &[key(BackTab, SHIFT)]), (b"\x1b", &[])]);
}

#[test]
fn stream_navigation_function_and_modified_keys() {
    check_keys(&[
        (b"\x1b[A", Up, NONE),
        (b"\x1b[B", Down, NONE),
        (b"\x1b[C", Right, NONE),
        (b"\x1b[D", Left, NONE),
        (b"\x1b[H", Home, NONE),
        (b"\x1b[F", End, NONE),
        (b"\x1b[E", KeypadBegin, NONE),
        (b"\x1b[1~", Home, NONE),
        (b"\x1b[2~", Insert, NONE),
        (b"\x1b[3~", Delete, NONE),
        (b"\x1b[4~", End, NONE),
        (b"\x1b[5~", PageUp, NONE),
        (b"\x1b[6~", PageDown, NONE),
        (b"\x1b[7~", Home, NONE),
        (b"\x1b[8~", End, NONE),
        (b"\x1b[11~", F(1), NONE),
        (b"\x1b[12~", F(2), NONE),
        (b"\x1b[13~", F(3), NONE),
        (b"\x1b[14~", F(4), NONE),
        (b"\x1b[15~", F(5), NONE),
        (b"\x1b[17~", F(6), NONE),
        (b"\x1b[18~", F(7), NONE),
        (b"\x1b[19~", F(8), NONE),
        (b"\x1b[20~", F(9), NONE),
        (b"\x1b[21~", F(10), NONE),
        (b"\x1b[23~", F(11), NONE),
        (b"\x1b[24~", F(12), NONE),
        (b"\x1bOP", F(1), NONE),
        (b"\x1bOQ", F(2), NONE),
        (b"\x1bOR", F(3), NONE),
        (b"\x1bOS", F(4), NONE),
        // The Linux console's F1 to F5 and PuTTY's Page Up and Page Down.
        (b"\x1b[[A", F(1), NONE),
        (b"\x1b[[B", F(2), NONE),
        (b"\x1b[[C", F(3), NONE),
        (b"\x1b[[D", F(4), NONE),
        (b"\x1b[[E", F(5), NONE),
        (b"\x1b[[5~", PageUp, NONE),
        (b"\x1b[[6~", PageDown, NONE),
        (b"\x1bOA", Up, NONE),
        (b"\x1bOB", Down, NONE),
        (b"\x1bOC", Right, NONE),
        (b"\x1bOD", Left, NONE),
        (b"\x1bOH", Home, NONE),
        (b"\x1bOF", End, NONE),
        (b"\x1bOE", KeypadBegin, NONE),
        (b"\x1b[a", Up, SHIFT),
        (b"\x1b[b", Down, SHIFT),
        (b"\x1b[c", Right, SHIFT),
        (b"\x1b[d", Left, SHIFT),
        (b"\x1bOa", Up, CTRL),
        (b"\x1bOb", Down, CTRL),
        (b"\x1bOc", Right, CTRL),
        (b"\x1bOd", Left, CTRL),
        (b"\x1b[2$", Insert, SHIFT),
        (b"\x1b[3$", Delete, SHIFT),
        (b"\x1b[5$", PageUp, SHIFT),
        (b"\x1b[6$", PageDown, SHIFT),
        (b"\x1b[2^", Insert, CTRL),
        (b"\x1b[3^", Delete, CTRL),
        (b"\x1b[5^", PageUp, CTRL),
        (b"\x1b[6^", PageDown, CTRL),
    ]);
    for (number, modifiers) in [(2, SHIFT), (3, ALT), (4, SHIFT | ALT), (5, CTRL), (6, SHIFT | CTRL), (7, ALT | CTRL)] {
        for (letter, code) in [('A', Up), ('B', Down), ('C', Right), ('D', Left)] {
            let bytes = format!("\x1b[1;{number}{letter}");
            assert_eq!(parse(bytes.as_bytes()), [key(code, modifiers)], "{}", bytes.escape_debug());
        }
    }
}

#[test]
fn stream_alt_keys() {
    for letter in "acdeghijklmoqrstuvwxyz".chars() {
        assert_eq!(parse(format!("\x1b{letter}").as_bytes()), [key(Char(letter), ALT)]);
    }
    check_keys(&[
        (b"\x1bb", Char('b'), ALT),
        (b"\x1bf", Char('f'), ALT),
        (b"\x1bB", Left, ALT),
        (b"\x1bF", Right, ALT),
        (b"\x1bn", Char('n'), ALT),
        (b"\x1bp", Char('p'), ALT),
        (b"\x1b\r", Enter, ALT),
        (b"\x1b\n", LineFeed, ALT),
        (b"\x1b\x7f", Backspace, ALT),
        (b"\x1b\x08", Backspace, ALT),
        (b"\x1b ", Char(' '), ALT),
        (b"\x1b\x1b[A", Up, ALT),
        (b"\x1bA", Char('A'), ALT),
        (b"\x1b\x01", Char('a'), CTRL | ALT),
        (b"\x1b5", Char('5'), ALT),
    ]);
    let mut timed = Timed::new();
    assert_eq!(timed.feed(b"\x1b\x1b"), []);
    assert_eq!(timed.wait(20), [key(Escape, ALT)]);
}

#[test]
fn stream_kitty_and_modify_other_keys() {
    check_kinds(&[
        (b"\x1b[97u", Char('a'), NONE, Press),
        (b"\x1b[32u", Char(' '), NONE, Press),
        (b"\x1b[97;2u", Char('A'), SHIFT, Press),
        (b"\x1b[32;2u", Char(' '), SHIFT, Press),
        (b"\x1b[97;5u", Char('a'), CTRL, Press),
        (b"\x1b[32;5u", Char(' '), CTRL, Press),
        (b"\x1b[97;3u", Char('a'), ALT, Press),
        (b"\x1b[97;6u", Char('A'), CTRL | SHIFT, Press),
        (b"\x1b[97;1:3u", Char('a'), NONE, Release),
        (b"\x1b[27u", Escape, NONE, Press),
        (b"\x1b[13u", Enter, NONE, Press),
        (b"\x1b[9u", Tab, NONE, Press),
        (b"\x1b[127u", Backspace, NONE, Press),
        (b"\x1b[57349u", Delete, NONE, Press),
        (b"\x1b[57348u", Insert, NONE, Press),
        (b"\x1b[57364u", F(1), NONE, Press),
        (b"\x1b[57375u", F(12), NONE, Press),
        (b"\x1b[1;1:1A", Up, NONE, Press),
        (b"\x1b[1;1:3A", Up, NONE, Release),
        (b"\x1b[1;5:1C", Right, CTRL, Press),
        (b"\x1b[1;2:1D", Left, SHIFT, Press),
        (b"\x1b[1;1:1H", Home, NONE, Press),
        (b"\x1b[1;1:3F", End, NONE, Release),
        (b"\x1b[1;1:1P", F(1), NONE, Press),
        (b"\x1b[5;1:1~", PageUp, NONE, Press),
        (b"\x1b[3;5:1~", Delete, CTRL, Press),
        (b"\x1b[2;1:3~", Insert, NONE, Release),
        (b"\x1b[27;2;13~", Enter, SHIFT, Press),
        (b"\x1b[27;5;13~", Enter, CTRL, Press),
        (b"\x1b[27;5;27~", Escape, CTRL, Press),
        (b"\x1b[27;3;9~", Tab, ALT, Press),
        (b"\x1b[27;2;32~", Char(' '), SHIFT, Press),
        (b"\x1b[27;5;127~", Backspace, CTRL, Press),
        (b"\x1b[27;2;53~", Char('5'), SHIFT, Press),
    ]);
}

#[test]
fn stream_mouse() {
    let scroll = |kind| mouse(kind, 9, 4, NONE);
    check(&[
        (b"\x1b[<0;1;1M", &[mouse(Mouse::Down(Button::Left), 0, 0, NONE)]),
        (b"\x1b[<0;1;1m", &[mouse(Mouse::Up(Button::Left), 0, 0, NONE)]),
        (b"\x1b[<1;1;1M", &[mouse(Mouse::Down(Button::Middle), 0, 0, NONE)]),
        (b"\x1b[<1;1;1m", &[mouse(Mouse::Up(Button::Middle), 0, 0, NONE)]),
        (b"\x1b[<2;1;1M", &[mouse(Mouse::Down(Button::Right), 0, 0, NONE)]),
        (b"\x1b[<2;1;1m", &[mouse(Mouse::Up(Button::Right), 0, 0, NONE)]),
        (b"\x1b[<64;10;5M", &[scroll(Mouse::ScrollUp)]),
        (b"\x1b[<65;10;5M", &[scroll(Mouse::ScrollDown)]),
        (b"\x1b[<66;10;5M", &[scroll(Mouse::ScrollLeft)]),
        (b"\x1b[<67;10;5M", &[scroll(Mouse::ScrollRight)]),
        (b"\x1b[<35;20;10M", &[mouse(Mouse::Moved, 19, 9, NONE)]),
        (b"\x1b[<0;300;200M", &[mouse(Mouse::Down(Button::Left), 299, 199, NONE)]),
        (b"\x1b[<4;1;1M", &[mouse(Mouse::Down(Button::Left), 0, 0, SHIFT)]),
        (b"\x1b[<8;1;1M", &[mouse(Mouse::Down(Button::Left), 0, 0, ALT)]),
        (b"\x1b[<16;1;1M", &[mouse(Mouse::Down(Button::Left), 0, 0, CTRL)]),
        (
            b"\x1b[<0;5;5M\x1b[<32;6;5M",
            &[mouse(Mouse::Down(Button::Left), 4, 4, NONE), mouse(Mouse::Drag(Button::Left), 5, 4, NONE)],
        ),
        (
            b"\x1b[<0;1;1M\x1b[<0;2;1M\x1b[<0;2;1m",
            &[
                mouse(Mouse::Down(Button::Left), 0, 0, NONE),
                mouse(Mouse::Down(Button::Left), 1, 0, NONE),
                mouse(Mouse::Up(Button::Left), 1, 0, NONE),
            ],
        ),
    ]);
    assert_eq!(split(&[b"\x1b[<64;10;", b"5M"]), [scroll(Mouse::ScrollUp)]);
    for (code, x, y, kind, modifiers) in [
        (0, 0, 0, Mouse::Down(Button::Left), NONE),
        (1, 0, 0, Mouse::Down(Button::Middle), NONE),
        (2, 0, 0, Mouse::Down(Button::Right), NONE),
        (3, 0, 0, Mouse::Up(Button::Left), NONE),
        (0, 10, 20, Mouse::Down(Button::Left), NONE),
        (35, 4, 5, Mouse::Moved, NONE),
        (64, 2, 3, Mouse::ScrollUp, NONE),
        (4, 0, 0, Mouse::Down(Button::Left), SHIFT),
        (80, 7, 8, Mouse::ScrollUp, CTRL),
    ] {
        assert_eq!(parse(&x10(code, x, y)), [mouse(kind, x.into(), y.into(), modifiers)], "{code}");
    }
    check(&[(b"\x1b[M !!x", &[mouse(Mouse::Down(Button::Left), 0, 0, NONE), ch('x')])]);
    assert_eq!(split(&[b"\x1b[M", b" !!"]), [mouse(Mouse::Down(Button::Left), 0, 0, NONE)]);
}

#[test]
fn stream_utf8_and_eight_bit_alt() {
    check(&[
        ("é".as_bytes(), &[ch('é')]),
        ("中".as_bytes(), &[ch('中')]),
        ("👍".as_bytes(), &[ch('👍')]),
        ("日本語".as_bytes(), &[ch('日'), ch('本'), ch('語')]),
        // A byte that cannot be UTF-8 is an eight-bit Alt key: 0xc0 is 128 + '@', 0xe9 128 + 'i', 0xff 128 + DEL.
        (b"\xc0A", &[key(Char('@'), ALT), ch('A')]),
        (b"\xff", &[key(Backspace, ALT)]),
    ]);
    for character in ["é", "中", "👍"] {
        let bytes = character.as_bytes();
        for index in 1..bytes.len() {
            let mut timed = Timed::new();
            assert_eq!(timed.feed(&bytes[..index]), []);
            assert_eq!(timed.feed(&bytes[index..]), [ch(character.chars().next().unwrap())]);
        }
    }
    let mut timed = Timed::new();
    assert_eq!(timed.feed(b"\xe9"), []);
    assert_eq!(timed.feed(b"x"), [key(Char('i'), ALT), ch('x')]);
}

#[test]
fn stream_replies_and_partial_sequences() {
    check(&[
        (b"\x1b]4;0;#ffffff\x07", &[reply(b"\x1b]4;0;#ffffff\x07")]),
        (b"\x1b]4;0;rgb:ff/ff/ff\x1b\\", &[reply(b"\x1b]4;0;rgb:ff/ff/ff\x1b\\")]),
        (b"\x1bP>|kitty(0.40.1)\x1b\\", &[reply(b"\x1bP>|kitty(0.40.1)\x1b\\")]),
        (b"\x1b_Gi=1;OK\x1b\\", &[reply(b"\x1b_Gi=1;OK\x1b\\")]),
        // BEL ends only OSC strings.
        (b"\x1bPa\x07b\x1b\\q", &[reply(b"\x1bPa\x07b\x1b\\"), ch('q')]),
        (b"\x1b[I", &[focus(true)]),
        (b"\x1b[O", &[focus(false)]),
        (b"\x1b[?62;1;2;6;7;8;9;15;22c", &[reply(b"\x1b[?62;1;2;6;7;8;9;15;22c")]),
        (b"\x1b[24;80R", &[reply(b"\x1b[24;80R")]),
        (b"\x1b[4;600;800t", &[reply(b"\x1b[4;600;800t")]),
        (b"\x1b[?2004;1$y", &[reply(b"\x1b[?2004;1$y")]),
        (
            b"\x1b]4;0;#fff\x07\x1bP>|test\x1b\\\x1b_OK\x1b\\",
            &[reply(b"\x1b]4;0;#fff\x07"), reply(b"\x1bP>|test\x1b\\"), reply(b"\x1b_OK\x1b\\")],
        ),
        (b"a\x1b[Ib\x1b[Oc", &[ch('a'), focus(true), ch('b'), focus(false), ch('c')]),
        (b"\x1b[?997;1n", &[reply(b"\x1b[?997;1n")]),
    ]);
    assert_eq!(split(&[b"\x1b]4;0;", b"#ffffff\x07"]), [reply(b"\x1b]4;0;#ffffff\x07")]);
    assert_eq!(split(&[b"\x1bPtest\x1b", b"\\"]), [reply(b"\x1bPtest\x1b\\")]);

    // A partial sequence whose next byte takes longer than the timeout is a reply, and later input is not swallowed.
    for (head, tail, expected) in [
        (b"\x1bO".as_slice(), b"a".as_slice(), [reply(b"\x1bO"), ch('a')]),
        (b"\x1b]incomplete", b"a", [reply(b"\x1b]incomplete"), ch('a')]),
        (b"\x1bPpartial", b"a", [reply(b"\x1bPpartial"), ch('a')]),
        (b"\x1b_partial", b"a", [reply(b"\x1b_partial"), ch('a')]),
        (b"\x1b[123", b"a", [reply(b"\x1b[123"), ch('a')]),
        (b"\x1b[80;120", b"a", [reply(b"\x1b[80;120"), ch('a')]),
        (b"\x1b[1;5", b"A", [reply(b"\x1b[1;5"), ch('A')]),
        (b"\x1b[24;80", b"R", [reply(b"\x1b[24;80"), ch('R')]),
        (b"\x1b]52;c;", b"\x1b[A", [reply(b"\x1b]52;c;"), key(Up, NONE)]),
        (b"\x1b[118;5", b"a", [reply(b"\x1b[118;5"), ch('a')]),
    ] {
        let mut timed = Timed::new();
        assert_eq!(timed.feed(head), [], "{}", String::from_utf8_lossy(head).escape_debug());
        assert_eq!(timed.wait(20), [expected[0].clone()], "{}", String::from_utf8_lossy(head).escape_debug());
        assert_eq!(timed.feed(tail), [expected[1].clone()], "{}", String::from_utf8_lossy(head).escape_debug());
    }
    // The timeout counts from the latest byte, so a sequence that keeps arriving keeps waiting.
    let response = b"\x1b[4;1080;1920t";
    let mut timed = Timed::new();
    for byte in response.chunks(1) {
        assert_eq!(timed.wait(15), []);
        let out = timed.feed(byte);
        assert_eq!(out, if byte == b"t" { vec![reply(response)] } else { vec![] });
    }
    // A partial mouse report always waits for the rest, as do Kitty keys while Kitty flags are on and replies while
    // the host expects them (Core's protocol contexts). A byte that cannot continue one reports it.
    let (plain, kitty, probing) =
        (Expectations::NONE, Expectations::KITTY_KEYBOARD, Expectations::REPLIES | Expectations::CURSOR_POSITION);
    type Case = (Expectations, &'static [u8], &'static [u8], Vec<Input>);
    let cases: [Case; 15] = [
        (plain, b"\x1b[<35;20", b";5m", vec![mouse(Mouse::Moved, 19, 4, NONE)]),
        (plain, b"\x1b[20", b"0~a\rb\x1b[201~", vec![paste("a\rb")]),
        (kitty, b"\x1b[118;5", b";3u", vec![key(Char('v'), CTRL)]),
        (kitty, b"\x1b[97;", b"2u", vec![key(Char('A'), SHIFT)]),
        (kitty, b"\x1b[97:65;", b"6:1u", vec![key(Char('A'), CTRL | SHIFT)]),
        (kitty, b"\x1b[97;9", b"u", vec![key(Char('a'), SUPER)]),
        (kitty, b"\x1b[1;1:", b"3A", vec![key_kind(Up, NONE, Release)]),
        (kitty, b"\x1b[27;5", b"u", vec![key(Escape, CTRL)]),
        (kitty, b"\x1b[118;5", b"\x1b[A", vec![reply(b"\x1b[118;5"), key(Up, NONE)]),
        (kitty, b"\x1b[118;5", b"a", vec![reply(b"\x1b[118;5"), ch('a')]),
        (kitty, b"\x1b[1;5", b"A", vec![reply(b"\x1b[1;5"), ch('A')]),
        (probing, b"\x1b[?1016;2$", b"y", vec![reply(b"\x1b[?1016;2$y")]),
        (probing, b"\x1b[?62;", b"c", vec![reply(b"\x1b[?62;c")]),
        (probing, b"\x1b[?997;1", b"n", vec![reply(b"\x1b[?997;1n")]),
        (probing, b"\x1b[1;2", b"R", vec![reply(b"\x1b[1;2R")]),
    ];
    for (expectations, head, tail, expected) in cases {
        let mut timed = Timed::expecting(expectations);
        assert_eq!(timed.feed(head), [], "{}", String::from_utf8_lossy(head).escape_debug());
        assert_eq!(timed.wait(100), [], "{}", String::from_utf8_lossy(head).escape_debug());
        assert_eq!(timed.feed(tail), expected, "{}", String::from_utf8_lossy(head).escape_debug());
    }
}

#[test]
fn stream_bracketed_paste() {
    check(&[
        (b"\x1b[200~hello\x1b[201~", &[paste("hello")]),
        (b"\x1b[200~\x1b[201~", &[paste("")]),
        (b"\x1b[200~line1\nline2\x1b[201~", &[paste("line1\nline2")]),
        (b"\x1b[200~a\tb\x1b[201~", &[paste("a\tb")]),
        (b"\x1b[200~abc\x1bdef\x1b[201~", &[paste("abc\x1bdef")]),
        (b"\x1b[200~abc\x1b[202~def\x1b[201~", &[paste("abc\x1b[202~def")]),
        (b"\x1b[200~\r\x1b[A\x1b[201!\x1b\x1b[201~", &[paste("\r\x1b[A\x1b[201!\x1b")]),
        (b"\x1b[200~hello\x1b[201~\x1b[A", &[paste("hello"), key(Up, NONE)]),
        (b"\x1b[200~first\x1b[201~\x1b[200~second\x1b[201~", &[paste("first"), paste("second")]),
        ("\x1b[200~日本語👍\x1b[201~".as_bytes(), &[paste("日本語👍")]),
    ]);
    let start = b"\x1b[200~";
    for index in 1..start.len() {
        assert_eq!(split(&[&start[..index], &[&start[index..], b"hi\x1b[201~"].concat()]), [paste("hi")]);
    }
    let end = b"\x1b[201~";
    for index in 1..end.len() {
        let mut timed = Timed::new();
        timed.feed(b"\x1b[200~hello");
        assert_eq!(timed.feed(&end[..index]), []);
        assert_eq!(timed.feed(&end[index..]), [paste("hello")]);
    }
    assert_eq!(split(&[b"\x1b[200~abc\x1b", b"\x1b[201~"]), [paste("abc\x1b")]);
    let payload = "x".repeat(100_000);
    assert_eq!(parse(format!("\x1b[200~{payload}\x1b[201~z").as_bytes()), [paste(&payload), ch('z')]);
    // Native code reports a paste in pieces of the payload buffer's size; joined, it keeps at most 4 MiB.
    for length in [(4 << 20) - 1, 4 << 20, (4 << 20) + 1] {
        let pasted = parse(format!("\x1b[200~{}\x1b[201~", "p".repeat(length)).as_bytes());
        assert!(matches!(&pasted[..], [Input::Event(Event::Paste(text))] if text.len() == length.min(4 << 20)));
    }
    let chunks: Vec<&[u8]> = [b"\x1b[200~".as_slice()]
        .into_iter()
        .chain(std::iter::repeat_n(b"chunk ".as_slice(), 1000))
        .chain([b"\x1b[201~".as_slice()])
        .collect();
    assert_eq!(split(&chunks), [paste(&"chunk ".repeat(1000))]);
    let thumbs = "👍".as_bytes();
    assert_eq!(split(&[b"\x1b[200~", &thumbs[..2], &thumbs[2..], b"\x1b[201~"]), [paste("👍")]);
    let markers: Vec<&[u8]> = [b"\x1b[200~".as_slice()]
        .into_iter()
        .chain(std::iter::repeat_n(b"\x1b[20".as_slice(), 100))
        .chain([b"\x1b[201~".as_slice()])
        .collect();
    assert_eq!(split(&markers), [paste(&"\x1b[20".repeat(100))]);
    let mut timed = Timed::new();
    assert_eq!(timed.feed(b"\x1b[200~partial"), []);
    assert_eq!(timed.wait(100), []);
    assert_eq!(timed.feed(b"\x1b[201~"), [paste("partial")]);
}

#[test]
fn stream_recovers_mouse_reports_after_a_timed_out_escape() {
    let after_escape = |chunks: &[&[u8]]| {
        let mut timed = Timed::new();
        assert_eq!(timed.feed(b"\x1b"), []);
        assert_eq!(timed.wait(20), [key(Escape, NONE)]);
        chunks.iter().flat_map(|chunk| timed.feed(chunk)).collect::<Vec<_>>()
    };
    assert_eq!(after_escape(&[b"[<64;38;15M"]), [mouse(Mouse::ScrollUp, 37, 14, NONE)]);
    assert_eq!(after_escape(&[b"[<35;20;5m"]), [mouse(Mouse::Moved, 19, 4, NONE)]);
    assert_eq!(after_escape(&[b"[<0;10;5M"]), [mouse(Mouse::Down(Button::Left), 9, 4, NONE)]);
    assert_eq!(after_escape(&[b"[", b"<35;20;5m"]), [mouse(Mouse::Moved, 19, 4, NONE)]);
    assert_eq!(after_escape(&[b"[M", b" !!"]), [mouse(Mouse::Down(Button::Left), 0, 0, NONE)]);
    assert_eq!(after_escape(&[b"[<x"]), [reply(b"[<"), ch('x')]);
    assert_eq!(after_escape(&[b"[<0M"]), [reply(b"[<0M")]);
    assert_eq!(after_escape(&[b"[A"]), [ch('['), ch('A')]);
    for partial in [b"[<35;".as_slice(), b"[<35;20", b"[<35;20;", b"[<", b"[<64;20;10"] {
        assert_eq!(after_escape(&[partial]), [], "{}", String::from_utf8_lossy(partial));
    }
    // A partial report then times out like any other sequence, and so does a lone `[`.
    let mut timed = Timed::new();
    timed.feed(b"\x1b");
    timed.wait(20);
    assert_eq!(timed.feed(b"[<35;20"), []);
    assert_eq!(timed.wait(20), [reply(b"[<35;20")]);
    assert_eq!(timed.feed(b";5m"), [ch(';'), ch('5'), ch('m')]);
    timed.feed(b"\x1b");
    timed.wait(20);
    assert_eq!(timed.feed(b"["), []);
    assert_eq!(timed.wait(19), []);
    assert_eq!(timed.wait(1), [ch('[')]);
    // Without a timed-out Escape, `[<` is text.
    assert_eq!(parse(b"[<35;20;5m"), "[<35;20;5m".chars().map(ch).collect::<Vec<_>>());
    assert_eq!(split(&[b"[", b"<"]), [ch('['), ch('<')]);
}

#[test]
fn stream_timeouts() {
    assert_eq!(ESCAPE_TIMEOUT, Duration::from_millis(20));
    let mut timed = Timed::new();
    timed.feed(b"\x1b");
    assert_eq!(timed.wait(19), []);
    assert_eq!(timed.wait(1), [key(Escape, NONE)]);
    for _ in 0..3 {
        timed.feed(b"\x1b");
        assert_eq!(timed.wait(20), [key(Escape, NONE)]);
    }
    timed.feed(b"\x1b[<35;20;");
    timed.wait(9);
    assert_eq!(timed.feed(b"5"), []);
    timed.wait(9);
    assert_eq!(timed.feed(b"m"), [mouse(Mouse::Moved, 19, 4, NONE)]);
    timed.feed(b"\x1b");
    timed.wait(5);
    assert_eq!(timed.feed(b"[A"), [key(Up, NONE)]);
    assert_eq!(timed.wait(100), []);
}

#[test]
fn stream_escape_interrupts_a_sequence() {
    check(&[
        (b"\x1b[<35;\x1b[<35;20;5m", &[reply(b"\x1b[<35;"), mouse(Mouse::Moved, 19, 4, NONE)]),
        (b"\x1b]foo\x1b\\", &[reply(b"\x1b]foo\x1b\\")]),
        (b"\x1b]foo\x1b[A", &[reply(b"\x1b]foo"), key(Up, NONE)]),
        (b"\x1bO\x1b[A", &[reply(b"\x1bO"), key(Up, NONE)]),
        (b"\x1bO\x1bOA", &[reply(b"\x1bO"), key(Up, NONE)]),
    ]);
    let mut timed = Timed::new();
    assert_eq!(timed.feed(b"\x1b[123\x1b"), [reply(b"\x1b[123")]);
    assert_eq!(timed.wait(20), [key(Escape, NONE)]);
}

#[test]
fn stream_chunk_shape_invariance() {
    for stream in [
        b"abc".as_slice(),
        b"\x1b[A",
        b"\x1bOP",
        b"\x1b[[A",
        b"\x1b[[5~",
        b"\x1b[<0;10;20M",
        b"\x1b[M !!",
        b"\x1b]4;0;#ffffff\x07",
        b"\x1bP>|test\x1b\\",
        b"\x1b_OK\x1b\\",
        b"\x1b[200~hello\x1b[201~",
        b"\x1b[I",
        b"\x1b[1;5A",
        b"\x1b[97u",
        b"\x1b[27;2;13~",
        "x\x1b[<64;10;5M\x1b[I\x1b]4;0;#fff\x07\x1b[200~paste\x1b[201~👍".as_bytes(),
        b"x\x1b[<64;10;5M\x1b[I\x1b]4;0;#fff\x07\x1b[200~p\x1b[201~y",
    ] {
        assert_split_invariant(stream);
    }
    let atoms: [&[u8]; 8] = [
        b"xy",
        "👍".as_bytes(),
        b"\x1b[A",
        b"\x1b[<64;10;5M",
        &x10(0, 0, 0),
        b"\x1b]4;0;#fff\x07",
        b"\x1b[200~p\x1b[201~",
        b"\x1b[97u",
    ];
    for first in atoms {
        for second in atoms {
            assert_split_invariant(&[first, second].concat());
        }
    }
}

#[test]
fn stream_interleaved_events_and_edge_cases() {
    let scroll = mouse(Mouse::ScrollUp, 9, 4, NONE);
    check(&[
        (b"x\x1b[<64;10;5M", &[ch('x'), scroll.clone()]),
        (b"\x1b[<64;10;5Mx", &[scroll, ch('x')]),
        (b"a\x1b[Ib", &[ch('a'), focus(true), ch('b')]),
        (b"\x1b[200~hi\x1b[201~z", &[paste("hi"), ch('z')]),
        (b"abc", &[ch('a'), ch('b'), ch('c')]),
        (b"\x1b[Ax\x1b[<0;1;1M", &[key(Up, NONE), ch('x'), mouse(Mouse::Down(Button::Left), 0, 0, NONE)]),
        (
            b"\x1b]4;0;#fff\x07a\x1b[<0;1;1M\x1b[200~p\x1b[201~",
            &[reply(b"\x1b]4;0;#fff\x07"), ch('a'), mouse(Mouse::Down(Button::Left), 0, 0, NONE), paste("p")],
        ),
        (b"\x1b[h", &[reply(b"\x1b[h")]),
        (b"\x1b!", &[key(Char('!'), ALT)]),
        (b"\x1bN", &[key(Char('N'), ALT)]),
        (b"\x1b[<0M", &[reply(b"\x1b[<0M")]),
        (b"\x1b[201~", &[reply(b"\x1b[201~")]),
    ]);
}
