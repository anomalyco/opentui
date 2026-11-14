//! Safe owners for OpenTUI's native Context, Session, scene, and frames.
//!
//! This layer maps closely to the C ABI. Native code owns layout, painting, and output encoding; the host owns time,
//! input, and transport. Every type here is single-threaded: none are `Send` or `Sync`.
//!
//! ```compile_fail
//! fn send<T: Send>() {}
//! send::<opentui::native::Context>();
//! ```
//!
//! ```compile_fail
//! fn sync<T: Sync>() {}
//! sync::<opentui::native::Session>();
//! ```
//!
//! ```compile_fail
//! fn send<T: Send>() {}
//! send::<opentui::native::Node>();
//! ```

mod buffer;
mod clipboard;
mod context;
mod editor;
#[cfg(all(test, feature = "tree-sitter"))]
pub(crate) use editor::{MARK_READS, RULE_CALLS, TEXT_READS};
mod frame;
mod markdown;
mod measure;
mod node;
mod record;
mod resource;
mod session;
mod terminal;
mod text;
mod video;

pub use buffer::Buffer;
pub use clipboard::{ClipboardOperation, ClipboardOptions, ClipboardOutcome, ClipboardSelection, ClipboardService};
pub use context::{Context, ContextOptions, Diagnostic, DiagnosticLevel};
pub use editor::{
    EditBuffer, EditCommand, EditInfo, EditPosition, EditQuery, EditorInfo, EditorOptions, EditorPosition, EditorQuery,
    EditorView, Highlight, LayerRun, SelectionColors, SelectionUnit, SyntaxStyle, Viewport,
};
pub use frame::{Capture, Cell, Draft, FrameOptions, Hooks, HostRequest, PaintSlot, RenderOutcome};
pub(crate) use frame::{Lease, Planes};
pub(crate) use markdown::{MarkdownBlock, MarkdownDoc, MarkdownLeaf, MarkdownOptions, MarkdownResult};
pub(crate) use measure::resume_measure_panic;
pub use measure::{Constraint, Measure};
pub use node::{
    ArrowDirection, ArrowOptions, BoxDetails, BoxSides, Node, NodeKind, Observation, Paint, SliderOptions, TextInfo,
    TextOptions, WrapMode,
};
pub use record::{BoxSpec, GridSpec, PaintCell, Phase, Recorder};
pub(crate) use resource::Resource;
pub use session::{
    Capabilities, CapabilityFlags, Control, Corner, CursorPosition, CursorStyle, CursorUpdate, FrameStats,
    KittyImageReply, KittyKeyboard, MousePointer, MouseTracking, Multiplexer, OutputTicket, ProgramKind, ProgramState,
    ProgramStatus, Pump, Remote, RendererState, Session, SessionOptions, SessionState, TerminalOptions, TerminalState,
    WidthMethod,
};
pub use terminal::{
    EmbeddedTerminal, EmbeddedTerminalOptions, TERMINAL_INPUT_BYTES_MAX, TerminalCursor, TerminalCursorShape,
    TerminalKey, TerminalMouse, TerminalMouseAction, TerminalMouseButton, TerminalViewport,
};
pub use text::{
    Image, ImageFit, ImageInfo, ImageProtocol, TextBuffer, TextBufferInfo, TextMeasure, TextView, VisualLine,
};
pub(crate) use video::video_path;
pub use video::{VideoInfo, VideoState};

/// Debug output for handles whose state lives in native code: only the type's name.
macro_rules! opaque_debug {
    ($($name:ident),+) => {$(
        impl std::fmt::Debug for $name {
            fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
                formatter.debug_struct(stringify!($name)).finish_non_exhaustive()
            }
        }
    )+};
}

opaque_debug!(Context, Session, TextBuffer, TextView, EditBuffer, EditorView, SyntaxStyle, Image, EmbeddedTerminal);

#[cfg(test)]
mod tests;
