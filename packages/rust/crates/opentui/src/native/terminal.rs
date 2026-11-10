use super::resource::{Resource, read_bytes, read_string};
use super::{Buffer, Context};
use crate::error::{Error, Result, Status, check};
use crate::input::{KeyEventKind, Modifiers};
use crate::style::Color;
use crate::sys;
use std::rc::Rc;

/// The most bytes one native write, key text, or paste accepts. [`EmbeddedTerminal::write`] splits longer input.
pub const TERMINAL_INPUT_BYTES_MAX: usize = 1 << 20;

/// The size of a new [`EmbeddedTerminal`].
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct EmbeddedTerminalOptions {
    /// Columns, at least 1.
    pub cols: u16,
    /// Rows, at least 1.
    pub rows: u16,
    /// The memory kept for lines scrolled off the top, in bytes. Native code keeps whole pages of rows, so a small
    /// limit still keeps some history; zero keeps none.
    pub max_scrollback: u32,
}

impl Default for EmbeddedTerminalOptions {
    /// 80 by 24 with 10 MB of scrollback, Ghostty's default.
    fn default() -> Self {
        Self { cols: 80, rows: 24, max_scrollback: 10_000_000 }
    }
}

/// The cursor shape a program asked for.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Hash)]
pub enum TerminalCursorShape {
    Bar,
    #[default]
    Block,
    Underline,
    HollowBlock,
}

/// The emulated cursor as of the latest [`EmbeddedTerminal::compose`].
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct TerminalCursor {
    /// The zero-based column and row in the visible screen, or `None` before the first compose and while the cursor
    /// is scrolled out of view.
    pub position: Option<(u16, u16)>,
    /// Whether the program shows the cursor.
    pub visible: bool,
    pub blinking: bool,
    /// The cursor sits on the right half of a wide character; draw it one column to the left.
    pub wide_tail: bool,
    pub shape: TerminalCursorShape,
    pub color: Option<Color>,
}

/// Where the view sits in the active screen's rows, from [`EmbeddedTerminal::viewport`].
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Hash)]
pub struct TerminalViewport {
    /// Rows from the live screen: 0 there, `total - visible` at the top of the history.
    pub offset: u32,
    /// Every row, the visible ones included. The alternate screen has no history, so there it equals `visible`.
    pub total: u32,
    pub visible: u32,
}

impl TerminalViewport {
    /// The view shows the live screen.
    pub fn at_live(&self) -> bool {
        self.offset == 0
    }

    /// The view shows the oldest rows, or there is no history.
    pub fn at_top(&self) -> bool {
        self.offset >= self.total.saturating_sub(self.visible)
    }
}

/// A key for [`EmbeddedTerminal::encode_key`].
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct TerminalKey<'a> {
    pub kind: KeyEventKind,
    /// The physical key as a W3C `KeyboardEvent.code` name, such as `"KeyA"`, `"Digit1"`, `"Enter"`, `"ArrowUp"`, or
    /// `"F5"`. Empty when unknown.
    pub code: &'a str,
    /// Hyper has no encoding and is dropped; Meta is sent as Super.
    pub modifiers: Modifiers,
    /// Modifiers the keyboard layout used to produce `text`, such as Shift for `"A"`.
    pub consumed: Modifiers,
    /// An input method is composing text.
    pub composing: bool,
    /// The text the key types, if any. Without text, only `code` names the key.
    pub text: &'a str,
    /// The character the key types without Shift, on the active layout.
    pub unshifted: Option<char>,
}

impl Default for TerminalKey<'_> {
    fn default() -> Self {
        Self {
            kind: KeyEventKind::Press,
            code: "",
            modifiers: Modifiers::NONE,
            consumed: Modifiers::NONE,
            composing: false,
            text: "",
            unshifted: None,
        }
    }
}

/// What a [`TerminalMouse`] event does.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub enum TerminalMouseAction {
    Press,
    Release,
    Motion,
}

/// A mouse button as terminals report it. Wheel steps are presses of the wheel buttons.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub enum TerminalMouseButton {
    Left,
    Middle,
    Right,
    WheelUp,
    WheelDown,
    WheelLeft,
    WheelRight,
}

/// A mouse event for [`EmbeddedTerminal::encode_mouse`].
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct TerminalMouse {
    pub action: TerminalMouseAction,
    /// `None` for motion without a pressed button.
    pub button: Option<TerminalMouseButton>,
    pub modifiers: Modifiers,
    /// The column relative to the terminal's left edge, in cells. Positions outside the terminal are allowed.
    pub x: f32,
    /// The row relative to the terminal's top edge, in cells.
    pub y: f32,
    /// Some button is held, as during a drag.
    pub any_button_pressed: bool,
}

/// Native key modifier bits: Shift, Ctrl, Alt, Super, Caps Lock, and Num Lock.
fn key_mods(modifiers: Modifiers) -> u32 {
    [
        (Modifiers::SHIFT, 1),
        (Modifiers::CTRL, 2),
        (Modifiers::ALT, 4),
        (Modifiers::SUPER, 8),
        (Modifiers::META, 8),
        (Modifiers::CAPS_LOCK, 16),
        (Modifiers::NUM_LOCK, 32),
    ]
    .into_iter()
    .filter(|(modifier, _)| modifiers.contains(*modifier))
    .fold(0, |bits, (_, bit)| bits | bit)
}

/// A terminal emulator owned by a Context: it parses the output of a program, keeps its screen and scrollback, and
/// encodes keys, mouse events, pastes, and focus changes the way that program asked for them.
///
/// The host moves the bytes: it feeds program output to [`Self::write`], sends encoded input and
/// [`Self::drain_responses`] back to the program, and draws the screen with [`Self::compose`].
///
/// ```
/// use opentui::native::{Context, ContextOptions, EmbeddedTerminal, EmbeddedTerminalOptions};
///
/// let context = Context::new(ContextOptions::default())?;
/// let terminal = EmbeddedTerminal::new(&context, EmbeddedTerminalOptions { cols: 20, rows: 2, ..Default::default() })?;
/// terminal.write(b"\x1b[6n")?; // a cursor position query
/// assert_eq!(terminal.drain_responses()?, b"\x1b[1;1R");
/// # Ok::<(), opentui::Error>(())
/// ```
#[derive(Clone)]
pub struct EmbeddedTerminal(Rc<Resource>);

impl EmbeddedTerminal {
    /// An emulator with a blank screen and the cursor at the top-left cell.
    pub fn new(context: &Context, options: EmbeddedTerminalOptions) -> Result<Self> {
        let raw = sys::ot_embedded_terminal_options {
            cols: u32::from(options.cols),
            rows: u32::from(options.rows),
            max_scrollback: options.max_scrollback,
            ..Default::default()
        };
        let resource = Resource::create(
            context,
            "ot_embedded_terminal_create",
            ("ot_embedded_terminal_destroy", sys::ot_embedded_terminal_destroy),
            |context, handle| unsafe { sys::ot_embedded_terminal_create(context, &raw, handle) },
        )?;
        Ok(Self(Rc::new(resource)))
    }

    pub fn context(&self) -> &Context {
        self.0.context()
    }

    fn raw(&self) -> (*mut sys::ot_context, *const sys::ot_handle) {
        self.0.raw()
    }

    /// Feeds program output to the emulator. Escape sequences may be split across writes.
    pub fn write(&self, bytes: &[u8]) -> Result<()> {
        let (context, handle) = self.raw();
        for chunk in bytes.chunks(TERMINAL_INPUT_BYTES_MAX) {
            check("ot_embedded_terminal_write", unsafe {
                sys::ot_embedded_terminal_write(context, handle, chunk.as_ptr(), chunk.len() as u32)
            })?;
        }
        Ok(())
    }

    /// Changes the screen size. Columns and rows are at least 1.
    pub fn resize(&self, cols: u16, rows: u16) -> Result<()> {
        let (context, handle) = self.raw();
        check("ot_embedded_terminal_resize", unsafe {
            sys::ot_embedded_terminal_resize(context, handle, u32::from(cols), u32::from(rows))
        })
    }

    fn command(&self, command: u32, argument: i32) -> Result<()> {
        let (context, handle) = self.raw();
        check("ot_embedded_terminal_command", unsafe {
            sys::ot_embedded_terminal_command(context, handle, command, argument)
        })
    }

    /// Makes the next [`Self::compose`] redraw every row, not only the rows that changed since the last one.
    pub fn invalidate(&self) -> Result<()> {
        self.command(sys::OT_EMBEDDED_TERMINAL_INVALIDATE, 0)
    }

    /// Scrolls the view through the scrollback by `rows`: negative values move back in history. The view stays
    /// within the history and the live screen.
    pub fn scroll(&self, rows: i32) -> Result<()> {
        self.command(sys::OT_EMBEDDED_TERMINAL_SCROLL, rows)
    }

    /// Returns the view to the live screen after [`Self::scroll`].
    pub fn scroll_to_bottom(&self) -> Result<()> {
        self.scroll(i32::MAX)
    }

    pub fn clear_selection(&self) -> Result<()> {
        self.command(sys::OT_EMBEDDED_TERMINAL_CLEAR_SELECTION, 0)
    }

    /// Draws the default background in the terminal's default color (transparent) instead of the emulator's default
    /// background color.
    pub fn set_transparent_background(&self, transparent: bool) -> Result<()> {
        self.command(sys::OT_EMBEDDED_TERMINAL_SET_TRANSPARENT_BACKGROUND, i32::from(transparent))
    }

    /// Selects the text between two cells of the visible screen, both included, in reading order. Selected cells
    /// draw with their colors swapped.
    pub fn set_selection(&self, start: (u16, u16), end: (u16, u16)) -> Result<()> {
        let (context, handle) = self.raw();
        check("ot_embedded_terminal_set_selection", unsafe {
            sys::ot_embedded_terminal_set_selection(
                context,
                handle,
                u32::from(start.0),
                u32::from(start.1),
                u32::from(end.0),
                u32::from(end.1),
            )
        })
    }

    /// The selected text, with rows joined by line breaks. Empty without a selection.
    pub fn selected_text(&self) -> Result<String> {
        let (context, handle) = self.raw();
        read_string("ot_embedded_terminal_get_selected_text", |bytes, capacity, length| unsafe {
            sys::ot_embedded_terminal_get_selected_text(context, handle, bytes, capacity, length)
        })
    }

    /// Draws the visible screen into `target` with its top-left cell at a position.
    ///
    /// Only rows that changed since the previous compose are drawn, so `target` must keep its cells between calls.
    /// Call [`Self::invalidate`] first when drawing into a new or cleared buffer, or at another position.
    pub fn compose(&self, target: &Buffer, x: i32, y: i32) -> Result<()> {
        let target = target.handle();
        let (context, handle) = self.raw();
        check("ot_embedded_terminal_compose", unsafe {
            sys::ot_embedded_terminal_compose(context, handle, &target, std::ptr::null(), x, y)
        })
    }

    /// The cursor as of the latest [`Self::compose`].
    pub fn cursor(&self) -> Result<TerminalCursor> {
        let mut raw = sys::ot_embedded_terminal_cursor::default();
        let (context, handle) = self.raw();
        check("ot_embedded_terminal_cursor_get", unsafe {
            sys::ot_embedded_terminal_cursor_get(context, handle, &mut raw)
        })?;
        Ok(TerminalCursor {
            position: (raw.has_value != 0).then_some((raw.x as u16, raw.y as u16)),
            visible: raw.visible != 0,
            blinking: raw.blinking != 0,
            wide_tail: raw.wide_tail != 0,
            shape: match raw.style {
                0 => TerminalCursorShape::Bar,
                2 => TerminalCursorShape::Underline,
                3 => TerminalCursorShape::HollowBlock,
                _ => TerminalCursorShape::Block,
            },
            color: (raw.color_has_value != 0)
                .then(|| Color::rgb(raw.color_r as u8, raw.color_g as u8, raw.color_b as u8)),
        })
    }

    /// Where the view sits in the active screen's rows. Output, resizes, scrollback clears, and screen switches move
    /// the view as well as [`Self::scroll`]; read it after each.
    pub fn viewport(&self) -> Result<TerminalViewport> {
        let mut raw = sys::ot_embedded_terminal_scrollbar::default();
        let (context, handle) = self.raw();
        check("ot_embedded_terminal_scrollbar_get", unsafe {
            sys::ot_embedded_terminal_scrollbar_get(context, handle, &mut raw)
        })?;
        Ok(TerminalViewport { offset: raw.offset, total: raw.total, visible: raw.visible })
    }

    /// The bytes a key sends to the program, in the keyboard protocol it enabled. Empty when the key sends nothing,
    /// such as a release the program did not ask for.
    pub fn encode_key(&self, key: &TerminalKey<'_>) -> Result<Vec<u8>> {
        let raw = sys::ot_embedded_terminal_key {
            action: match key.kind {
                KeyEventKind::Release => 0,
                KeyEventKind::Press => 1,
                KeyEventKind::Repeat => 2,
            },
            composing: u32::from(key.composing),
            mods: key_mods(key.modifiers),
            consumed_mods: key_mods(key.consumed),
            unshifted_codepoint: key.unshifted.map_or(0, u32::from),
            ..Default::default()
        };
        let (code, text) = (key.code.as_bytes(), key.text.as_bytes());
        if code.len() > TERMINAL_INPUT_BYTES_MAX || text.len() > TERMINAL_INPUT_BYTES_MAX {
            return Err(Error::Native {
                operation: "ot_embedded_terminal_encode_key",
                status: Status::InvalidArgument,
            });
        }
        let (context, handle) = self.raw();
        read_bytes("ot_embedded_terminal_encode_key", |bytes, capacity, length| unsafe {
            sys::ot_embedded_terminal_encode_key(
                context,
                handle,
                &raw,
                code.as_ptr(),
                code.len() as u32,
                text.as_ptr(),
                text.len() as u32,
                bytes,
                capacity,
                length,
            )
        })
    }

    /// The bytes a mouse event sends to the program. Empty unless the program tracks the mouse, and for motion it
    /// did not ask for or that stays in the same cell.
    pub fn encode_mouse(&self, mouse: &TerminalMouse) -> Result<Vec<u8>> {
        let raw = sys::ot_embedded_terminal_mouse {
            action: match mouse.action {
                TerminalMouseAction::Press => 0,
                TerminalMouseAction::Release => 1,
                TerminalMouseAction::Motion => 2,
            },
            button: match mouse.button {
                None => -1,
                Some(TerminalMouseButton::Left) => 1,
                Some(TerminalMouseButton::Right) => 2,
                Some(TerminalMouseButton::Middle) => 3,
                Some(TerminalMouseButton::WheelUp) => 4,
                Some(TerminalMouseButton::WheelDown) => 5,
                Some(TerminalMouseButton::WheelLeft) => 6,
                Some(TerminalMouseButton::WheelRight) => 7,
            },
            mods: key_mods(mouse.modifiers),
            any_button_pressed: u32::from(mouse.any_button_pressed),
            x: mouse.x,
            y: mouse.y,
            ..Default::default()
        };
        let (context, handle) = self.raw();
        read_bytes("ot_embedded_terminal_encode_mouse", |bytes, capacity, length| unsafe {
            sys::ot_embedded_terminal_encode_mouse(context, handle, &raw, bytes, capacity, length)
        })
    }

    /// Whether the program asked for mouse reports, so a left press would reach it.
    pub fn tracks_mouse(&self) -> Result<bool> {
        let raw = sys::ot_embedded_terminal_mouse { action: 0, button: 1, ..Default::default() };
        let (context, handle) = self.raw();
        let mut count = 0;
        // A sizing query encodes without keeping any mouse state.
        check("ot_embedded_terminal_encode_mouse", unsafe {
            sys::ot_embedded_terminal_encode_mouse(context, handle, &raw, std::ptr::null_mut(), 0, &mut count)
        })?;
        Ok(count > 0)
    }

    /// The bytes a paste sends: bracketed when the program enabled bracketed paste. At most
    /// [`TERMINAL_INPUT_BYTES_MAX`] bytes.
    pub fn encode_paste(&self, text: &[u8]) -> Result<Vec<u8>> {
        let (context, handle) = self.raw();
        let length = crate::error::count("ot_embedded_terminal_encode_paste", text.len())?;
        read_bytes("ot_embedded_terminal_encode_paste", |bytes, capacity, count| unsafe {
            sys::ot_embedded_terminal_encode_paste(context, handle, text.as_ptr(), length, bytes, capacity, count)
        })
    }

    /// The focus report for gaining or losing focus, when the program asked for focus reports.
    pub fn encode_focus(&self, focused: bool) -> Result<Vec<u8>> {
        let (context, handle) = self.raw();
        read_bytes("ot_embedded_terminal_encode_focus", |bytes, capacity, length| unsafe {
            sys::ot_embedded_terminal_encode_focus(context, handle, u32::from(focused), bytes, capacity, length)
        })
    }

    /// Removes and returns the replies the emulator owes the program, such as answers to cursor position and device
    /// status queries. Send them to the program like input. Native code keeps at most 1 MiB of them.
    pub fn drain_responses(&self) -> Result<Vec<u8>> {
        const OPERATION: &str = "ot_embedded_terminal_drain_responses";
        let (context, handle) = self.raw();
        let mut responses = Vec::new();
        let mut chunk = [0u8; 4096];
        let mut overflowed = false;
        loop {
            let mut count = 0;
            let status = unsafe {
                sys::ot_embedded_terminal_drain_responses(
                    context,
                    handle,
                    chunk.as_mut_ptr(),
                    chunk.len() as u32,
                    &mut count,
                )
            };
            // An overflow is reported once; the retained prefix is still there to drain.
            if status == sys::OT_OUTPUT_BACKPRESSURE && !overflowed {
                overflowed = true;
                continue;
            }
            check(OPERATION, status)?;
            responses.extend_from_slice(&chunk[..count as usize]);
            if (count as usize) < chunk.len() {
                return Ok(responses);
            }
        }
    }
}
