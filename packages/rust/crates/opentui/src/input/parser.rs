use super::event::{Event, KeyCode, KeyEvent, KeyEventKind, Modifiers, MouseButton, MouseEvent, MouseEventKind};
use crate::error::{Error, Result, Status};
use crate::native::{Context, ContextOptions, Session, SessionOptions};
use crate::sys;
use std::ops::BitOr;
use std::time::{Duration, Instant};

/// How long a partial sequence waits for its next byte, as in Core. A lone Escape then counts as the Escape key, and
/// other partial sequences are reported as replies, so a key that starts like a sequence (Alt+Shift+P in a legacy
/// terminal) cannot hold up the input that follows it. A split UTF-8 character waits for its rest without a deadline,
/// and so does a bare `ESC [` after this timeout, which may start a mouse report on a slow link: the next input
/// completes or ends it.
pub const ESCAPE_TIMEOUT: Duration = Duration::from_nanos(sys::OT_INPUT_TIMEOUT_NS);

// The records and payload bytes one native call fills, as Core's adapter allocates them.
const RECORDS: usize = 64;
const PAYLOAD_BYTES: usize = 16 * 1024;
const PASTE_BYTES_MAX: usize = 4 * 1024 * 1024;

const _: () =
    assert!(RECORDS >= sys::OT_INPUT_EVENTS_MIN as usize && PAYLOAD_BYTES >= sys::OT_INPUT_PAYLOAD_BYTES_MIN as usize);

/// One parsed item of terminal input.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Input {
    Event(Event),
    /// A complete terminal reply or an escape sequence that is not a key, mouse, focus, or paste event. Capability
    /// replies must go back to native code.
    Reply(Vec<u8>),
}

/// Input a [`Parser`] expects: replies to the host's queries, or Kitty keyboard keys. A partial sequence it expects
/// waits past [`ESCAPE_TIMEOUT`] for its rest, which a slow link can delay.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Hash)]
pub struct Expectations(u32);

impl Expectations {
    pub const NONE: Self = Self(0);
    /// Replies to queries the host sent, such as device attributes and mode reports. Set it while any query is
    /// outstanding.
    pub const REPLIES: Self = Self(sys::OT_INPUT_EXPECT_REPLIES);
    /// A cursor position report. Implies [`Self::REPLIES`], and makes `CSI 1 ; N R` a report instead of a modified
    /// F3 key.
    pub const CURSOR_POSITION: Self = Self(sys::OT_INPUT_EXPECT_CURSOR_POSITION);
    /// Kitty keyboard keys: a partial one waits for its rest, and `CSI R` and `CSI 1 ; N R` are replies, since the
    /// protocol sends F3 as `CSI 13 ~`. A Session with a renderer ignores this and uses the Kitty keyboard state its
    /// terminal negotiated.
    pub const KITTY_KEYBOARD: Self = Self(sys::OT_INPUT_EXPECT_KITTY_KEYBOARD);
}

impl BitOr for Expectations {
    type Output = Self;
    fn bitor(self, other: Self) -> Self {
        Self(self.0 | other.0)
    }
}

/// Splits terminal input bytes into key, mouse, paste, and focus events and terminal replies, with OpenTUI's native
/// input parser.
///
/// The parser's state lives in its Session, so use one parser for the Session's whole life. Input may arrive in
/// fragments: a partial sequence waits across calls while its bytes keep coming within [`ESCAPE_TIMEOUT`] of each
/// other, or longer as that says, and native code bounds every partial sequence, so hostile or corrupt input cannot
/// grow memory without limit.
pub struct Parser {
    session: Session,
    records: Box<[sys::ot_input_event]>,
    payload: Box<[u8]>,
    expectations: Expectations,
    /// The instant native time counts from: the first one fed.
    origin: Option<Instant>,
    /// The latest native time fed. Native time must not go backwards, so an earlier instant counts as this one.
    now_ns: u64,
    deadline_ns: u64,
    paste: Option<Vec<u8>>,
}

impl Parser {
    /// A parser whose state lives in `session`. With a renderer, the Session reads Kitty keys as its terminal
    /// negotiated. Native code rejects its input if another parser fed `session` before: a Session has one input clock.
    pub fn new(session: &Session) -> Self {
        Self::with_sink(session, RECORDS, PAYLOAD_BYTES)
    }

    /// A parser with its own Context and Session, for input that no other Session parses, such as replies read
    /// before a renderer exists. Its Session has no renderer, so [`Expectations::KITTY_KEYBOARD`] applies.
    pub fn standalone() -> Result<Self> {
        // The smallest Context and Session that parse input, as Core's adapter makes them.
        let context = Context::new(ContextOptions { object_capacity: 4, render_cells_max: 1 })?;
        let options = SessionOptions { chunk_size: 4096, span_capacity: 2, max_bytes: 8192, control_capacity: 0 };
        Ok(Self::new(&Session::new(&context, options)?))
    }

    fn with_sink(session: &Session, records: usize, payload_bytes: usize) -> Self {
        Self {
            session: session.clone(),
            records: vec![sys::ot_input_event::default(); records].into_boxed_slice(),
            payload: vec![0; payload_bytes].into_boxed_slice(),
            expectations: Expectations::NONE,
            origin: None,
            now_ns: 0,
            deadline_ns: 0,
            paste: None,
        }
    }

    /// Sets what the parser expects from `now` on, then ends what is due, as [`Self::expire`] does. A partial sequence
    /// that may no longer wait gets a deadline, and ends here if that already passed.
    pub fn set_expectations(&mut self, expectations: Expectations, now: Instant, out: &mut Vec<Input>) -> Result<()> {
        if expectations != self.expectations {
            if let Err(error) = self.session.input_expect(expectations.0) {
                return self.stop(error);
            }
            self.expectations = expectations;
        }
        // Native code emits nothing for a change, so feed nothing to end what may no longer wait, as Core does.
        self.expire(now, out)
    }

    /// Parses `bytes` that arrived at `now`, appending results to `out`. A partial sequence whose deadline passed
    /// first ends as [`Self::expire`] ends it.
    pub fn feed(&mut self, bytes: &[u8], now: Instant, out: &mut Vec<Input>) -> Result<()> {
        let origin = *self.origin.get_or_insert(now);
        let now_ns = u64::try_from(now.saturating_duration_since(origin).as_nanos()).unwrap_or(u64::MAX);
        self.now_ns = self.now_ns.max(now_ns);
        let mut rest = bytes;
        // At least one call, so that zero bytes still end an expired sequence.
        loop {
            let drain = match self.session.input_feed(rest, self.now_ns, &mut self.records, &mut self.payload) {
                Ok(drain) => drain,
                Err(error) => return self.stop(error),
            };
            self.deadline_ns = drain.deadline_ns;
            // The next call reuses the payload, so translate the records now.
            for record in self.records.iter().take(drain.count as usize) {
                translate(record, &self.payload, &mut self.paste, out);
            }
            // A call can consume nothing after it reported events, but not do neither: the sink always has room.
            assert!(drain.consumed > 0 || drain.count > 0 || rest.is_empty(), "native input parser made no progress");
            rest = &rest[drain.consumed as usize..];
            if rest.is_empty() {
                return Ok(());
            }
        }
    }

    /// When the host should call [`Self::expire`], if a partial sequence is waiting.
    pub fn deadline(&self) -> Option<Instant> {
        let origin = self.origin.filter(|_| self.deadline_ns != 0)?;
        origin.checked_add(Duration::from_nanos(self.deadline_ns))
    }

    /// Ends a partial sequence whose deadline passed by `now`, as Core does: a lone Escape is the Escape key, a
    /// cut-off UTF-8 character is eight-bit Alt keys, and anything else is a reply. A partial mouse report, Kitty
    /// key, or expected reply keeps waiting for bytes that continue it.
    pub fn expire(&mut self, now: Instant, out: &mut Vec<Input>) -> Result<()> {
        self.feed(&[], now, out)
    }

    /// Drops a partial sequence and paste after the process resumed from a suspension. Feed the input that arrived
    /// meanwhile first: what is still partial after it is stale, except the start of a reply the host still expects,
    /// which keeps waiting for its rest.
    pub fn resume(&mut self) -> Result<()> {
        self.session.input_reset(true).or_else(|error| self.stop(error))?;
        self.paste = None;
        self.deadline_ns = 0;
        Ok(())
    }

    /// Stops parsing quietly once the Session is gone, as Core does, and fails otherwise. Native code refuses every
    /// later call on a gone Session the same way, so nothing needs to remember the stop.
    fn stop(&mut self, error: Error) -> Result<()> {
        if !matches!(
            error.status(),
            Some(Status::SessionClosed | Status::OutputFailed | Status::StaleHandle | Status::WrongContext)
        ) {
            return Err(error);
        }
        self.deadline_ns = 0;
        self.paste = None;
        Ok(())
    }
}

/// A span of the payload. Native code keeps spans within the payload it filled.
fn span(payload: &[u8], offset: u32, length: u32) -> &[u8] {
    payload.get(offset as usize..).and_then(|rest| rest.get(..length as usize)).unwrap_or_default()
}

fn translate(record: &sys::ot_input_event, payload: &[u8], paste: &mut Option<Vec<u8>>, out: &mut Vec<Input>) {
    let text = span(payload, record.text_offset, record.text_len);
    match u32::from(record.kind) {
        sys::OT_INPUT_KEY => key(record, text, span(payload, record.raw_offset, record.raw_len), out),
        sys::OT_INPUT_MOUSE => out.push(Input::Event(Event::Mouse(mouse(record)))),
        sys::OT_INPUT_PASTE => {
            let flags = u32::from(record.flags);
            // A paste can span several calls; only the first record starts it.
            let bytes = paste.get_or_insert_default();
            if flags & sys::OT_INPUT_PASTE_START != 0 {
                bytes.clear();
            }
            let room = PASTE_BYTES_MAX - bytes.len();
            bytes.extend_from_slice(&text[..text.len().min(room)]);
            if flags & sys::OT_INPUT_PASTE_END != 0 {
                let bytes = paste.take().unwrap_or_default();
                out.push(Input::Event(Event::Paste(String::from_utf8_lossy(&bytes).into_owned())));
            }
        }
        sys::OT_INPUT_FOCUS => out.push(Input::Event(Event::Focus(u32::from(record.action) == sys::OT_INPUT_FOCUS_IN))),
        // OT_INPUT_REPLY, the only other kind.
        _ => out.push(Input::Reply(span(payload, record.raw_offset, record.raw_len).to_vec())),
    }
}

/// Native key codes from Insert to Menu.
const FUNCTION_KEYS: [KeyCode; 16] = [
    KeyCode::Insert,
    KeyCode::Delete,
    KeyCode::Left,
    KeyCode::Right,
    KeyCode::Up,
    KeyCode::Down,
    KeyCode::PageUp,
    KeyCode::PageDown,
    KeyCode::Home,
    KeyCode::End,
    KeyCode::CapsLock,
    KeyCode::ScrollLock,
    KeyCode::NumLock,
    KeyCode::PrintScreen,
    KeyCode::Pause,
    KeyCode::Menu,
];

/// Native key codes from keypad Left to keypad Delete.
const KEYPAD_KEYS: [KeyCode; 10] = [
    KeyCode::Left,
    KeyCode::Right,
    KeyCode::Up,
    KeyCode::Down,
    KeyCode::PageUp,
    KeyCode::PageDown,
    KeyCode::Home,
    KeyCode::End,
    KeyCode::Insert,
    KeyCode::Delete,
];

/// Translates a native key, whose characters are reported as sent, into this crate's keys: Shift applies to
/// characters, Shift+Tab is BackTab, a legacy line feed is LineFeed, keypad keys are the keys they stand for with
/// [`KeyEvent::keypad`] set, and text with several characters is a key per character.
fn key(record: &sys::ot_input_event, text: &[u8], raw: &[u8], out: &mut Vec<Input>) {
    let modifiers = Modifiers::from_bits(record.modifiers);
    let shift = modifiers.contains(Modifiers::SHIFT);
    let kitty = u32::from(record.flags) & sys::OT_INPUT_KEY_KITTY != 0;
    // Native text is what the key inserts: an input method's text for code 0, a keypad key's character, or a Kitty
    // key's text, which has Shift applied and can hold several characters.
    let keypad_text = matches!(
        record.code,
        sys::OT_INPUT_KEY_KP_0..=sys::OT_INPUT_KEY_KP_ADD | sys::OT_INPUT_KEY_KP_EQUAL | sys::OT_INPUT_KEY_KP_SEPARATOR
    );
    let inserts_text = record.code == 0 || keypad_text || kitty;
    // A character typed from the private-use area shares its code with a Kitty functional key, so native marks it.
    let typed = u32::from(record.flags) & sys::OT_INPUT_KEY_TYPED != 0;
    // Other characters come as sent: modifyOtherKeys reports Shift+a as `a` with Shift.
    let character = |code| {
        let character = char::from_u32(code).expect("native key codes are Unicode scalars");
        let mut upper = character.to_uppercase();
        KeyCode::Char(match (shift, upper.next(), upper.next()) {
            (true, Some(single), None) => single,
            _ => character,
        })
    };
    let mut rest = "".chars();
    let code = match record.code {
        code if typed => character(code),
        sys::OT_INPUT_KEY_ESCAPE => KeyCode::Escape,
        // Native code reports a line feed byte as Enter; Core tells them apart by the raw byte, as here.
        sys::OT_INPUT_KEY_ENTER if !kitty && raw.ends_with(b"\n") => KeyCode::LineFeed,
        sys::OT_INPUT_KEY_ENTER | sys::OT_INPUT_KEY_KP_ENTER => KeyCode::Enter,
        sys::OT_INPUT_KEY_BACKSPACE => KeyCode::Backspace,
        // Shortcuts name Shift+Tab BackTab, as legacy terminals report it.
        sys::OT_INPUT_KEY_TAB if shift => KeyCode::BackTab,
        sys::OT_INPUT_KEY_TAB => KeyCode::Tab,
        code @ sys::OT_INPUT_KEY_INSERT..=sys::OT_INPUT_KEY_MENU => {
            FUNCTION_KEYS[(code - sys::OT_INPUT_KEY_INSERT) as usize]
        }
        code @ sys::OT_INPUT_KEY_F1..=sys::OT_INPUT_KEY_F35 => KeyCode::F((code - sys::OT_INPUT_KEY_F1 + 1) as u8),
        code @ sys::OT_INPUT_KEY_KP_LEFT..=sys::OT_INPUT_KEY_KP_DELETE => {
            KEYPAD_KEYS[(code - sys::OT_INPUT_KEY_KP_LEFT) as usize]
        }
        sys::OT_INPUT_KEY_KP_BEGIN => KeyCode::KeypadBegin,
        code @ sys::OT_INPUT_KEY_MEDIA_PLAY..=sys::OT_INPUT_KEY_ISO_LEVEL5_SHIFT => KeyCode::Other(code),
        _ if inserts_text && !text.is_empty() => {
            rest = std::str::from_utf8(text).unwrap_or_default().chars();
            KeyCode::Char(rest.next().expect("native key text is UTF-8"))
        }
        code => character(code),
    };
    let kind = match u32::from(record.action) {
        sys::OT_INPUT_KEY_REPEAT => KeyEventKind::Repeat,
        sys::OT_INPUT_KEY_RELEASE => KeyEventKind::Release,
        _ => KeyEventKind::Press,
    };
    // A base-layout key adds something only where it differs from the typed key and its lowercase form.
    let base_layout = match code {
        KeyCode::Char(character) => char::from_u32(record.base_code)
            .filter(|base| !base.is_control() && *base != character && Some(*base) != character.to_lowercase().next()),
        _ => None,
    };
    // Native code reports keypad codes only for Kitty keys; legacy keypad sequences come as the keys they stand for.
    let keypad = matches!(record.code, sys::OT_INPUT_KEY_KP_0..=sys::OT_INPUT_KEY_KP_DELETE) && !typed;
    let key = KeyEvent { code, modifiers, kind, base_layout, keypad };
    out.push(Input::Event(Event::Key(key)));
    out.extend(rest.map(|character| Input::Event(Event::Key(KeyEvent { code: KeyCode::Char(character), ..key }))));
}

fn mouse(record: &sys::ot_input_event) -> MouseEvent {
    let button = || match record.code {
        0 => MouseButton::Left,
        1 => MouseButton::Middle,
        2 => MouseButton::Right,
        code => MouseButton::Other(code as u8),
    };
    let kind = match u32::from(record.action) {
        sys::OT_INPUT_MOUSE_DOWN => MouseEventKind::Down(button()),
        sys::OT_INPUT_MOUSE_UP => MouseEventKind::Up(button()),
        sys::OT_INPUT_MOUSE_DRAG => MouseEventKind::Drag(button()),
        sys::OT_INPUT_MOUSE_SCROLL => [
            MouseEventKind::ScrollUp,
            MouseEventKind::ScrollDown,
            MouseEventKind::ScrollLeft,
            MouseEventKind::ScrollRight,
        ][(record.code & 3) as usize],
        // OT_INPUT_MOUSE_MOVE, the only other action.
        _ => MouseEventKind::Moved,
    };
    MouseEvent { kind, x: record.x, y: record.y, modifiers: Modifiers::from_bits(record.modifiers) }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn ch(character: char) -> Input {
        Input::Event(Event::Key(KeyCode::Char(character).into()))
    }

    fn reply(bytes: &[u8]) -> Input {
        Input::Reply(bytes.to_vec())
    }

    #[test]
    fn time_never_goes_backwards() -> Result<()> {
        let start = Instant::now();
        let mut parser = Parser::standalone()?;
        let mut out = Vec::new();
        parser.feed(b"\x1b", start + ESCAPE_TIMEOUT, &mut out)?;
        assert_eq!(parser.deadline(), Some(start + 2 * ESCAPE_TIMEOUT));
        // An earlier instant counts as the latest one.
        parser.feed(b"[A", start, &mut out)?;
        assert_eq!(out, [Input::Event(Event::Key(KeyCode::Up.into()))]);
        assert_eq!(parser.deadline(), None);
        Ok(())
    }

    #[test]
    fn arbitrary_bytes_parse_the_same_in_any_fragments_sink_sizes_and_delays() -> Result<()> {
        let mut seed = 0x9e37_79b9_7f4a_7c15u64;
        let stream = arbitrary_bytes(&mut seed, 64 * 1024);
        let now = Instant::now();
        let mut whole = Vec::new();
        let mut parser = Parser::standalone()?;
        parser.feed(&stream, now, &mut whole)?;
        parser.expire(now + ESCAPE_TIMEOUT, &mut whole)?;
        // The smallest sink native code accepts holds about one byte's events, so every call stops early.
        let (records, payload_bytes) = (sys::OT_INPUT_EVENTS_MIN as usize, sys::OT_INPUT_PAYLOAD_BYTES_MIN as usize);
        let mut parser = Parser::with_sink(&Parser::standalone()?.session, records, payload_bytes);
        let (mut split, mut rest, mut later) = (Vec::new(), &stream[..], now);
        while !rest.is_empty() {
            let (chunk, tail) = rest.split_at((next(&mut seed) % 9 + 1).min(rest.len() as u64) as usize);
            // The timeout counts from each byte, so a sequence can take far longer than it as a whole.
            later += ESCAPE_TIMEOUT - Duration::from_millis(1);
            parser.feed(chunk, later, &mut split)?;
            rest = tail;
        }
        parser.expire(later + ESCAPE_TIMEOUT, &mut split)?;
        assert!(whole.iter().any(|input| matches!(input, Input::Event(Event::Paste(text)) if text.len() > 1)));
        assert_eq!(split, whole);
        Ok(())
    }

    #[test]
    fn resuming_keeps_only_the_start_of_an_expected_reply() -> Result<()> {
        for (expectations, head, tail, expected) in [
            (Expectations::REPLIES, b"\x1b[?62".as_slice(), b";c".as_slice(), vec![reply(b"\x1b[?62;c")]),
            (Expectations::NONE, b"\x1b[?62", b";c", vec![ch(';'), ch('c')]),
            (Expectations::REPLIES, b"\x1b[200~ab", b"c\x1b[201~", vec![ch('c'), reply(b"\x1b[201~")]),
        ] {
            let (mut parser, now, mut out) = (Parser::standalone()?, Instant::now(), Vec::new());
            parser.set_expectations(expectations, now, &mut out)?;
            parser.feed(head, now, &mut out)?;
            parser.resume()?;
            parser.feed(tail, now + Duration::from_secs(1), &mut out)?;
            assert_eq!(out, expected, "{}", String::from_utf8_lossy(head).escape_debug());
        }
        Ok(())
    }

    #[test]
    fn a_reply_that_is_no_longer_expected_stops_waiting() -> Result<()> {
        let (mut parser, start, mut out) = (Parser::standalone()?, Instant::now(), Vec::new());
        parser.set_expectations(Expectations::REPLIES, start, &mut out)?;
        parser.feed(b"\x1b[?62", start, &mut out)?;
        parser.expire(start + 5 * ESCAPE_TIMEOUT, &mut out)?;
        assert_eq!((&out[..], parser.deadline()), (&[][..], None));
        parser.set_expectations(Expectations::NONE, start + 5 * ESCAPE_TIMEOUT, &mut out)?;
        assert_eq!(out, [reply(b"\x1b[?62")]);
        // A sequence whose timeout has not passed yet gets its deadline back.
        let (mut parser, mut out) = (Parser::standalone()?, Vec::new());
        parser.set_expectations(Expectations::REPLIES, start, &mut out)?;
        parser.feed(b"\x1b[?62", start, &mut out)?;
        parser.set_expectations(Expectations::NONE, start, &mut out)?;
        assert_eq!((&out[..], parser.deadline()), (&[][..], Some(start + ESCAPE_TIMEOUT)));
        Ok(())
    }

    #[test]
    fn a_closed_session_drops_input_quietly_and_other_errors_fail() -> Result<()> {
        // Parsing stops quietly once the Session closes, is cancelled, or fails its output (`OutputFailed`).
        for end in [
            (|session| session.close().unwrap()) as fn(&Session),
            |session| session.cancel().unwrap(),
            |session| assert!(session.drain_output(1, |_| Err(std::io::ErrorKind::BrokenPipe.into())).is_err()),
        ] {
            let mut parser = Parser::standalone()?;
            let session = parser.session.clone();
            let mut out = Vec::new();
            parser.feed(b"\x1b[200~a", Instant::now(), &mut out)?;
            // Native code refuses a reset from its output callback and keeps the paste, so the parser keeps it too.
            let mut busy = None;
            session.write(b"x")?;
            session.drain_output(1, |_| {
                busy = parser.resume().err().and_then(|error| error.status());
                Ok(0)
            })?;
            assert_eq!(busy, Some(Status::ContextBusy));
            parser.feed(b"b\x1b[201~\x1b[200~a", Instant::now(), &mut out)?;
            end(&session);
            parser.feed(b"\x1b[201~", Instant::now(), &mut out)?;
            parser.set_expectations(Expectations::REPLIES, Instant::now(), &mut out)?;
            parser.resume()?;
            assert_eq!((out, parser.deadline()), (vec![Input::Event(Event::Paste("ab".into()))], None));
        }
        Ok(())
    }

    /// A small deterministic generator keeps the random tests reproducible without extra dependencies.
    fn next(seed: &mut u64) -> u64 {
        *seed ^= *seed << 13;
        *seed ^= *seed >> 7;
        *seed ^= *seed << 17;
        *seed
    }

    /// Random bytes biased toward the bytes and fragments that start or shape escape sequences.
    fn arbitrary_bytes(seed: &mut u64, length: usize) -> Vec<u8> {
        const FRAGMENTS: [&[u8]; 12] = [
            b"\x1b",
            b"\x1b[",
            b"\x1b[<",
            b"\x1b[M",
            b"\x1bO",
            b"\x1b]",
            b"\x1bP",
            b"\x1b\\",
            b"\x07",
            b"\x1b[200~",
            b"\x1b[201~",
            b"\x1b\x1b[",
        ];
        let mut bytes = Vec::with_capacity(length + 8);
        while bytes.len() < length {
            let value = next(seed);
            match value % 8 {
                0 | 1 => bytes.extend_from_slice(FRAGMENTS[(value >> 8) as usize % FRAGMENTS.len()]),
                2 => bytes.push(b";:$<M[~u"[(value >> 8) as usize % 8]),
                3 => bytes.push((value >> 8) as u8 % 10 + b'0'),
                _ => bytes.push((value >> 16) as u8),
            }
        }
        bytes
    }
}
