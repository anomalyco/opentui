use opentui::{ffi, Context, Node, Session};
use std::{
    io::{self, Write},
    time::{Duration, Instant},
};

pub type Result<T> = std::result::Result<T, Box<dyn std::error::Error>>;
pub type Color = [u16; 4];
pub const CELLS_MAX: u32 = 512 * 256;

unsafe extern "C" {
    fn rust_terminal_open() -> i32;
    fn rust_terminal_close() -> i32;
    fn rust_terminal_size(width: *mut u32, height: *mut u32) -> i32;
    fn rust_terminal_read(bytes: *mut u8, capacity: u32, timeout_ms: i32) -> i32;
    fn rust_terminal_write(bytes: *const u8, count: u32) -> i32;
    fn rust_terminal_report_error(bytes: *const u8, count: u32);
}

fn report_error(message: &str) {
    unsafe { rust_terminal_report_error(message.as_ptr(), message.len().min(u32::MAX as usize) as u32) };
}

struct Output;

impl Write for Output {
    fn write(&mut self, bytes: &[u8]) -> io::Result<usize> {
        let count = bytes.len().min(i32::MAX as usize) as u32;
        let written = unsafe { rust_terminal_write(bytes.as_ptr(), count) };
        if written < 0 {
            Err(io::Error::last_os_error())
        } else {
            Ok(written as usize)
        }
    }

    fn flush(&mut self) -> io::Result<()> {
        Ok(())
    }
}

pub fn size() -> Result<(u32, u32)> {
    let (mut width, mut height) = (0, 0);
    if unsafe { rust_terminal_size(&mut width, &mut height) } < 0 {
        return Err(io::Error::last_os_error().into());
    }
    if u64::from(width) * u64::from(height) > u64::from(CELLS_MAX) {
        return Err("terminal exceeds the example's 131072-cell limit".into());
    }
    Ok((width, height))
}

#[derive(Default, Copy, Clone, Debug)]
pub struct OutputStats {
    pub bytes: u64,
    pub tickets: u32,
    pub pumps: u32,
}

pub struct Terminal<'session, 'context> {
    session: &'session Session<'context>,
    clock: Instant,
    active: bool,
}

impl<'session, 'context> Terminal<'session, 'context> {
    fn open(session: &'session Session<'context>) -> Result<Self> {
        if unsafe { rust_terminal_open() } < 0 {
            return Err(io::Error::last_os_error().into());
        }
        Ok(Self { session, clock: Instant::now(), active: true })
    }

    pub fn elapsed(&self) -> Duration {
        self.clock.elapsed()
    }

    pub fn drain(&self) -> Result<OutputStats> {
        let mut stats = OutputStats::default();
        let mut bytes = [0; 4096];
        for _ in 0..4096 {
            let now = u64::try_from(self.elapsed().as_nanos())?;
            let result = self.session.pump(now, 1)?;
            stats.pumps += 1;
            match result.status {
                ffi::OT_PUMP_IDLE | ffi::OT_PUMP_CLOSED => return Ok(stats),
                ffi::OT_PUMP_AGAIN => {}
                ffi::OT_PUMP_WAIT_UNTIL => {
                    std::thread::sleep(Duration::from_nanos(result.deadline_ns.saturating_sub(now)));
                }
                ffi::OT_PUMP_OUTPUT_PENDING => {
                    let ticket = self.session.read_output(&mut bytes)?;
                    if ticket.byte_count == 0 {
                        return Err("native output stalled".into());
                    }
                    let delivered = Output.write_all(&bytes[..ticket.byte_count as usize]);
                    // A ticket is presented only after the transport accepts every byte.
                    self.session.complete_output(&ticket, delivered.is_ok())?;
                    delivered?;
                    stats.bytes += u64::from(ticket.byte_count);
                    stats.tickets += 1;
                }
                _ => return Err(format!("unexpected pump status: {}", result.status).into()),
            }
        }
        Err("native output exceeded the example's pump limit".into())
    }

    pub fn read(&self, bytes: &mut [u8], timeout: Duration) -> Result<Option<usize>> {
        if bytes.is_empty() {
            return Err("terminal input buffer must not be empty".into());
        }
        let timeout_ms = timeout.as_nanos().div_ceil(1_000_000).min(1000) as i32;
        let capacity = bytes.len().min(i32::MAX as usize) as u32;
        let count = unsafe { rust_terminal_read(bytes.as_mut_ptr(), capacity, timeout_ms) };
        match count {
            -2 => Ok(None),
            count if count >= 0 => Ok(Some(count as usize)),
            _ => Err(io::Error::last_os_error().into()),
        }
    }

    fn close(&mut self) -> Result<()> {
        if !self.active {
            return Ok(());
        }
        let restored = self.session.close().map_err(Into::into).and_then(|()| self.drain().map(|_| ()));
        let status = unsafe { rust_terminal_close() };
        self.active = false;
        if status < 0 {
            return Err(io::Error::last_os_error().into());
        }
        restored
    }
}

impl Drop for Terminal<'_, '_> {
    fn drop(&mut self) {
        if let Err(error) = self.close() {
            report_error(&format!("terminal restoration failed: {error}\n"));
        }
    }
}

pub fn text(node: &Node<'_, '_>, content: &str, color: Color, bold: bool) -> Result<()> {
    if content.is_empty() {
        node.set_text(b"")?;
        return Ok(());
    }
    node.set_styled_text_with_links(
        content.as_bytes(),
        &[ffi::ot_scene_linked_text_chunk {
            byte_count: content.len().try_into()?,
            flags: ffi::OT_SCENE_TEXT_FOREGROUND,
            foreground: color,
            attributes: u32::from(bold),
            ..Default::default()
        }],
        &[],
    )?;
    Ok(())
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Key {
    Char(u8),
    Up,
    Down,
    Left,
    Right,
    Home,
    End,
    PageUp,
    PageDown,
    Enter,
    Escape,
    Backspace,
    Tab,
    Interrupt,
}

#[derive(Default, Clone, Copy)]
enum InputState {
    #[default]
    Ground,
    Escape(Instant),
    Sequence {
        number: u16,
        plain: bool,
    },
    String,
    StringEscape,
    Paste(usize),
}

#[derive(Default)]
pub struct Input {
    state: InputState,
}

impl Input {
    pub fn timeout(&self, now: Instant, maximum: Duration) -> Duration {
        match self.state {
            InputState::Escape(start) => {
                maximum.min(Duration::from_millis(35).saturating_sub(now.saturating_duration_since(start)))
            }
            _ => maximum,
        }
    }

    pub fn keys<'a>(&'a mut self, bytes: &'a [u8], now: Instant) -> impl Iterator<Item = Key> + 'a {
        // A new batch must not consume an Escape whose timeout already elapsed.
        self.expire(now).into_iter().chain(bytes.iter().filter_map(move |&byte| self.feed(byte, now)))
    }

    pub fn feed(&mut self, byte: u8, now: Instant) -> Option<Key> {
        if byte == 3 {
            return Some(Key::Interrupt);
        }
        match self.state {
            InputState::Ground => match byte {
                0x1b => self.state = InputState::Escape(now),
                b' '..=b'~' => return Some(Key::Char(byte)),
                b'\r' | b'\n' => return Some(Key::Enter),
                8 | 127 => return Some(Key::Backspace),
                b'\t' => return Some(Key::Tab),
                _ => {}
            },
            InputState::Escape(_) => {
                self.state = match byte {
                    b'[' | b'O' => InputState::Sequence { number: 0, plain: true },
                    b']' | b'P' | b'_' | b'^' | b'X' => InputState::String,
                    0x1b => InputState::Escape(now),
                    _ => InputState::Ground,
                };
            }
            InputState::Sequence { number, plain } if (0x40..=0x7e).contains(&byte) => {
                self.state = InputState::Ground;
                if byte == b'~' {
                    return match number {
                        1 | 7 => Some(Key::Home),
                        4 | 8 => Some(Key::End),
                        5 => Some(Key::PageUp),
                        6 => Some(Key::PageDown),
                        200 => {
                            self.state = InputState::Paste(0);
                            None
                        }
                        _ => None,
                    };
                }
                if plain {
                    return match byte {
                        b'A' => Some(Key::Up),
                        b'B' => Some(Key::Down),
                        b'C' => Some(Key::Right),
                        b'D' => Some(Key::Left),
                        b'H' => Some(Key::Home),
                        b'F' => Some(Key::End),
                        _ => None,
                    };
                }
            }
            InputState::Sequence { number, .. } => {
                self.state = if byte == 0x1b {
                    InputState::Escape(now)
                } else {
                    InputState::Sequence {
                        number: if byte.is_ascii_digit() {
                            number.saturating_mul(10).saturating_add(u16::from(byte - b'0'))
                        } else {
                            u16::MAX
                        },
                        plain: false,
                    }
                };
            }
            InputState::String | InputState::StringEscape => {
                self.state = match byte {
                    7 => InputState::Ground,
                    0x1b => InputState::StringEscape,
                    b'\\' if matches!(self.state, InputState::StringEscape) => InputState::Ground,
                    _ => InputState::String,
                };
            }
            InputState::Paste(matched) => {
                // Paste payload is opaque, even when it contains escape prefixes.
                const END: &[u8] = b"\x1b[201~";
                self.state = if byte == END[matched] {
                    if matched + 1 == END.len() {
                        InputState::Ground
                    } else {
                        InputState::Paste(matched + 1)
                    }
                } else {
                    InputState::Paste(usize::from(byte == 0x1b))
                };
            }
        }
        None
    }

    pub fn expire(&mut self, now: Instant) -> Option<Key> {
        if let InputState::Escape(start) = self.state {
            if now.saturating_duration_since(start) >= Duration::from_millis(35) {
                self.state = InputState::Ground;
                return Some(Key::Escape);
            }
        }
        None
    }
}

pub fn run(
    object_capacity: u32,
    app: impl FnOnce(&Session<'_>, &Terminal<'_, '_>) -> Result<()>,
) -> std::process::ExitCode {
    let result = (|| -> Result<()> {
        if std::env::args().len() != 1 {
            return Err("this example takes no arguments".into());
        }
        let (width, height) = size()?;
        let context = Context::new(ffi::ot_context_options {
            object_capacity,
            render_cells_max: CELLS_MAX,
            ..Default::default()
        })?;
        let environment: Vec<_> = ["TERM", "COLORTERM", "TERM_PROGRAM", "NO_COLOR"]
            .into_iter()
            .filter_map(|key| std::env::var(key).ok().map(|value| (key, value)))
            .collect();
        let entries: Vec<_> = environment.iter().map(|(key, value)| (*key, value.as_str())).collect();
        let session = Session::new(
            &context,
            ffi::ot_session_options {
                chunk_size: 1024 * 1024,
                span_capacity: 2,
                max_bytes: 2 * 1024 * 1024,
                control_capacity: ffi::OT_SESSION_CONTROL_PACKET_BYTES,
                ..Default::default()
            },
        )?;
        session.attach_renderer(width, height, ffi::OT_SESSION_REMOTE_LOCAL, &entries)?;
        let mut terminal = Terminal::open(&session)?;
        let result = (|| {
            session.setup_terminal(&ffi::ot_session_terminal_options {
                flags: ffi::OT_TERMINAL_ALTERNATE_SCREEN,
                ..Default::default()
            })?;
            terminal.drain()?;
            app(&session, &terminal)
        })();
        let restored = terminal.close();
        result.and(restored)
    })();
    match result {
        Ok(()) => std::process::ExitCode::SUCCESS,
        Err(error) => {
            report_error(&format!("Error: {error}\n"));
            std::process::ExitCode::FAILURE
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn terminal_read_rejects_out_of_range_timeouts() {
        let mut byte = 0;
        for timeout_ms in [-1, 1001] {
            assert_eq!(unsafe { rust_terminal_read(&mut byte, 1, timeout_ms) }, -1);
            assert_eq!(io::Error::last_os_error().kind(), io::ErrorKind::InvalidInput);
        }
    }

    #[test]
    fn text_can_clear_styled_content() -> Result<()> {
        let context =
            Context::new(ffi::ot_context_options { object_capacity: 3, render_cells_max: 4096, ..Default::default() })?;
        let session = Session::new(
            &context,
            ffi::ot_session_options {
                chunk_size: ffi::OT_SESSION_CONTROL_PACKET_BYTES,
                span_capacity: 2,
                max_bytes: u64::from(ffi::OT_SESSION_CONTROL_PACKET_BYTES) * 2,
                control_capacity: ffi::OT_SESSION_CONTROL_PACKET_BYTES,
                ..Default::default()
            },
        )?;
        session.attach_renderer(4, 4, ffi::OT_SESSION_REMOTE_LOCAL, &[])?;
        let root = Node::new(&session, ffi::OT_SCENE_ROOT, 1)?;
        let node = Node::new(&session, ffi::OT_SCENE_TEXT, 2)?;
        node.mount(&root)?;
        text(&node, "initial", [255; 4], true)?;
        assert_eq!(node.text()?, b"initial");
        text(&node, "", [255; 4], false)?;
        assert!(node.text()?.is_empty());
        Ok(())
    }

    #[test]
    fn input_accepts_only_printable_ascii_and_known_controls() {
        let now = Instant::now();
        for byte in 0..=255 {
            let expected = match byte {
                3 => Some(Key::Interrupt),
                b'\r' | b'\n' => Some(Key::Enter),
                8 | 127 => Some(Key::Backspace),
                b'\t' => Some(Key::Tab),
                b' '..=b'~' => Some(Key::Char(byte)),
                _ => None,
            };
            assert_eq!(Input::default().feed(byte, now), expected, "byte {byte}");
        }
    }

    #[test]
    fn input_maps_navigation_sequences_across_fragments() {
        let cases: &[(&[u8], Key)] = &[
            (b"\x1b[A", Key::Up),
            (b"\x1b[B", Key::Down),
            (b"\x1b[C", Key::Right),
            (b"\x1b[D", Key::Left),
            (b"\x1b[H", Key::Home),
            (b"\x1b[F", Key::End),
            (b"\x1bOA", Key::Up),
            (b"\x1bOB", Key::Down),
            (b"\x1bOC", Key::Right),
            (b"\x1bOD", Key::Left),
            (b"\x1bOH", Key::Home),
            (b"\x1bOF", Key::End),
            (b"\x1b[1~", Key::Home),
            (b"\x1b[7~", Key::Home),
            (b"\x1b[4~", Key::End),
            (b"\x1b[8~", Key::End),
            (b"\x1b[5~", Key::PageUp),
            (b"\x1b[6~", Key::PageDown),
        ];
        let start = Instant::now();
        for &(bytes, key) in cases {
            let mut input = Input::default();
            for (index, &byte) in bytes.iter().enumerate() {
                // Once a prefix is recognized, replies and keys may span slow reads.
                let now = start + Duration::from_millis(if index < 2 { index as u64 } else { 100 * index as u64 });
                assert_eq!(input.expire(now), None);
                assert_eq!(input.feed(byte, now), (index + 1 == bytes.len()).then_some(key), "{bytes:?}");
            }
            assert_eq!(input.feed(b'j', start), Some(Key::Char(b'j')));
        }
    }

    #[test]
    fn input_expires_only_a_standalone_escape_after_35_ms() {
        let start = Instant::now();
        let mut input = Input::default();
        assert_eq!(input.feed(0x1b, start), None);
        assert_eq!(input.expire(start + Duration::from_millis(34)), None);
        assert_eq!(input.expire(start + Duration::from_millis(35)), Some(Key::Escape));
        assert_eq!(input.expire(start + Duration::from_secs(1)), None);
        assert_eq!(input.feed(b'q', start + Duration::from_secs(1)), Some(Key::Char(b'q')));

        assert_eq!(input.feed(0x1b, start), None);
        assert_eq!(input.feed(0x1b, start + Duration::from_millis(20)), None);
        assert_eq!(input.expire(start + Duration::from_millis(35)), None);
        assert_eq!(input.expire(start + Duration::from_millis(55)), Some(Key::Escape));
    }

    #[test]
    fn input_expires_escape_before_a_later_key_batch() {
        let now = Instant::now();
        let mut input = Input::default();
        assert_eq!(input.keys(b"\x1b", now).count(), 0);
        assert_eq!(input.keys(b"", now + Duration::from_millis(33)).count(), 0);
        assert_eq!(
            input.keys(b"q", now + Duration::from_millis(40)).collect::<Vec<_>>(),
            [Key::Escape, Key::Char(b'q')]
        );
    }

    #[test]
    fn idle_reads_wake_at_the_pending_escape_deadline() {
        let now = Instant::now();
        let mut input = Input::default();
        let idle = Duration::from_millis(100);
        assert_eq!(input.timeout(now, idle), idle);
        input.feed(0x1b, now);
        assert_eq!(input.timeout(now + Duration::from_millis(33), idle), Duration::from_millis(2));
        assert_eq!(input.timeout(now + Duration::from_millis(40), idle), Duration::ZERO);
        assert_eq!(input.keys(b"", now + Duration::from_millis(40)).collect::<Vec<_>>(), [Key::Escape]);
        assert_eq!(input.timeout(now + Duration::from_millis(40), idle), idle);
    }

    #[test]
    fn input_suppresses_terminal_replies_and_modified_keys() {
        let sequences: &[&[u8]] = &[
            b"\x1b[?1;2c",
            b"\x1b[>41;1;0c",
            b"\x1b[12;40R",
            b"\x1b[1;5A",
            b"\x1b[5;2~",
            b"\x1b[?200~",
            b"\x1b]10;rgb:ffff/ffff/ffff\x07",
            b"\x1b]11;rgb:0000/0000/0000\x1b\\",
            b"\x1bP1+r544e=787465726d\x1b\\",
            b"\x1b_payload j k q\x1b\\",
            b"\x1b^payload j k q\x1b\\",
            b"\x1bXpayload j k q\x1b\\",
        ];
        let now = Instant::now();
        for bytes in sequences {
            let mut input = Input::default();
            for &byte in *bytes {
                assert_eq!(input.feed(byte, now), None, "{bytes:?}");
            }
            assert_eq!(input.expire(now + Duration::from_secs(1)), None);
            assert_eq!(input.feed(b'q', now), Some(Key::Char(b'q')), "{bytes:?}");
        }
    }

    #[test]
    fn input_suppresses_paste_payload_and_partial_end_markers() {
        let start = Instant::now();
        let mut input = Input::default();
        let bytes = b"\x1b[200~qjk \r\t\x1b[A\x1b[201!\x1b[20\x1b\x1b[201~";
        for (index, &byte) in bytes.iter().enumerate() {
            let now = start + Duration::from_millis(index as u64 * 10);
            assert_eq!(input.expire(now), None);
            assert_eq!(input.feed(byte, now), None);
        }
        assert_eq!(input.feed(b'q', start), Some(Key::Char(b'q')));
    }

    #[test]
    fn input_always_delivers_interrupt() {
        let now = Instant::now();
        let prefixes: &[&[u8]] = &[b"", b"\x1b", b"\x1b[", b"\x1b[200~", b"\x1b]reply", b"\x1bP\x1b"];
        for prefix in prefixes {
            let mut input = Input::default();
            for &byte in *prefix {
                assert_eq!(input.feed(byte, now), None);
            }
            assert_eq!(input.feed(3, now), Some(Key::Interrupt), "{prefix:?}");
        }
    }

    #[test]
    fn input_bounds_large_parameters_and_payloads() {
        let now = Instant::now();
        let mut input = Input::default();
        for &byte in b"\x1b[" {
            assert_eq!(input.feed(byte, now), None);
        }
        for _ in 0..65536 {
            assert_eq!(input.feed(b'9', now), None);
        }
        assert_eq!(input.feed(b'~', now), None);
        assert_eq!(input.feed(b'q', now), Some(Key::Char(b'q')));
        for &byte in b"\x1b[200~" {
            assert_eq!(input.feed(byte, now), None);
        }
        for _ in 0..65536 {
            assert_eq!(input.feed(b'q', now), None);
        }
        for &byte in b"\x1b[201~" {
            assert_eq!(input.feed(byte, now), None);
        }
        assert_eq!(input.feed(b'q', now), Some(Key::Char(b'q')));
    }
}
