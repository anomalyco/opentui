//! Terminal input: parsing bytes into events and classifying terminal replies.
//!
//! Native code does not read the terminal. The host reads input and feeds it to a [`Parser`], which parses it with
//! the Session's native input parser and turns the results into [`Event`]s and replies. The host passes capability
//! replies back to the Session.

#[cfg(test)]
mod core_tests;
mod event;
mod keymap;
mod parser;
mod reply;

pub use event::{Event, KeyCode, KeyEvent, KeyEventKind, Modifiers, MouseButton, MouseEvent, MouseEventKind};
pub use keymap::{IntoShortcut, Keymap, ParseShortcutError, Shortcut};
pub use parser::{ESCAPE_TIMEOUT, Expectations, Input, Parser};
pub use reply::{
    OscColor, ThemeColor, is_capability_response, is_color_scheme_notice, is_cursor_report, is_device_attributes,
    osc_color, pixel_resolution, theme_color,
};
