//! A terminal UI framework for Rust, built on OpenTUI's native renderer.
//!
//! OpenTUI's native library keeps a retained scene of nodes, lays it out with Yoga, paints cells, and encodes
//! terminal output. This crate drives it from Rust.
//!
//! Most apps only need the framework layer:
//!
//! - [`app`] runs the event loop: input dispatch, focus, timers, animation, and messages from other threads.
//! - [`animation`] has timelines that tween values with easing, delays, and loops.
//! - [`widget`] has the widgets: [`View`](widget::View), [`Text`](widget::Text), [`Input`](widget::Input),
//!   [`Textarea`](widget::Textarea), [`Select`](widget::Select), [`TabSelect`](widget::TabSelect),
//!   [`Slider`](widget::Slider), [`ScrollBox`](widget::ScrollBox), [`Table`](widget::Table),
//!   [`TextTable`](widget::TextTable), [`Code`](widget::Code), [`LineNumbers`](widget::LineNumbers),
//!   [`Diff`](widget::Diff), [`Markdown`](widget::Markdown), [`TerminalView`](widget::TerminalView),
//!   [`ImageView`](widget::ImageView), [`VideoView`](widget::VideoView), [`FrameBuffer`](widget::FrameBuffer), and
//!   [`Custom`](widget::Custom) for your own.
//! - [`post`] has post-processing: color matrices, filters, and animated effects for a widget's area or the screen.
//! - [`pty`] runs programs on pseudo-terminals, for a [`TerminalView`](widget::TerminalView) or on their own.
//! - [`testing`] runs apps without a terminal for tests.
//!
//! ```no_run
//! use opentui::prelude::*;
//!
//! fn main() -> opentui::Result<()> {
//!     let app = App::new(AppOptions::default())?;
//!     app.root().add(&Text::new(&app, "Hello from Rust. Press q to quit.").fg(Color::CYAN));
//!     app.on_key(|cx, key| {
//!         if key.matches("q") {
//!             cx.quit();
//!         }
//!     });
//!     app.run()
//! }
//! ```
//!
//! The lower layers stay available:
//!
//! - [`native`] wraps the C ABI with safe, single-threaded owners.
//! - [`host`] runs one Session on the local terminal: setup, input, resizes, suspension, output, and restoration.
//! - [`input`] parses terminal input into key, mouse, paste, and focus events.
//! - [`term`] configures the local terminal and turns signals into pollable events.

pub use opentui_sys as sys;

pub mod animation;
pub mod app;
pub mod audio;
pub mod console;
pub mod error;
pub mod host;
pub mod input;
pub mod keymap;
pub mod layout;
pub mod native;
pub mod post;
pub mod pty;
pub mod remote;
pub mod split;
pub mod style;
pub mod syntax;
pub mod term;
pub mod testing;
pub mod theme;
pub mod widget;

pub use app::{App, AppOptions};
pub use error::{Error, Result, Status};

/// The types most apps use.
pub mod prelude {
    pub use crate::animation::{Easing, Timeline, Tween};
    pub use crate::app::{App, AppOptions, AppProxy, Cx, HandlerId, TimerId};
    pub use crate::input::{
        Event, KeyCode, KeyEvent, Keymap, Modifiers, MouseButton, MouseEvent, MouseEventKind, Shortcut,
    };
    pub use crate::layout::{
        Align, Edge, FlexDirection, Justify, LayoutMode, Length, Overflow, PositionType, Rect, Wrap,
    };
    pub use crate::native::{MousePointer, SelectionColors, WrapMode};
    pub use crate::post::{Channels, ColorMatrix, Filter, Surface};
    pub use crate::style::{Alignment, Attributes, BorderStyle, Color, Sides, Span, Style, Stylize};
    pub use crate::theme::{Theme, ThemeMode};
    pub use crate::widget::{
        AnyWidget, Code, Column, ColumnWidth, Component, Container, Content, Custom, Diff, DiffView, EditorAction,
        ExtmarkOptions, FrameBuffer, ImageView, Input, LineNumbers, Markdown, Painter, ScrollAction, ScrollBox, Select,
        SelectAction, SelectOption, Slider, SliderAction, TabSelect, TabSelectAction, Table, TableAction, TerminalView,
        Text, TextTable, Textarea, VideoEvent, VideoView, View, Widget,
    };
    pub use crate::{Error, Result};
}
