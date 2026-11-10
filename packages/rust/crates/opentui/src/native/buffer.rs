use super::frame::Lease;
use super::record::{BoxSpec, records};
use super::resource::Resource;
use super::{Capture, Context, Node, WidthMethod};
use crate::error::{Result, check};
use crate::style::{Color, Style};
use crate::sys::{self, Pod};
use std::cell::Cell;
use std::rc::Rc;

/// An offscreen grid of cells owned by a Context.
///
/// Draw into it once and show it in any number of frames with [`Recorder::draw_buffer`](super::Recorder::draw_buffer)
/// or [`Painter::draw_buffer`](crate::widget::Painter::draw_buffer). The cells stay until drawn over, resized, or
/// cleared. Coordinates are cells from the top-left corner; drawing outside the buffer is cut off.
///
/// ```
/// use opentui::native::{Buffer, Context, ContextOptions, WidthMethod};
/// use opentui::style::{Color, Style};
///
/// let context = Context::new(ContextOptions::default())?;
/// let buffer = Buffer::new(&context, 10, 2, WidthMethod::Unicode)?;
/// buffer.clear(Color::BLACK)?;
/// buffer.text(1, 0, "hello", Style::new().fg(Color::GREEN))?;
/// assert_eq!(buffer.capture()?.row(0), " hello    ");
/// # Ok::<(), opentui::Error>(())
/// ```
#[derive(Clone)]
pub struct Buffer(Rc<BufferInner>);

struct BufferInner {
    resource: Resource,
    size: Cell<(u32, u32)>,
}

impl std::fmt::Debug for Buffer {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter.debug_struct("Buffer").field("size", &self.size()).finish_non_exhaustive()
    }
}

impl Buffer {
    /// A `width` by `height` buffer of blank cells. `width_method` sets how wide drawn text is: normally the
    /// Session's detected method, such as [`App::width_method`](crate::App::width_method).
    pub fn new(context: &Context, width: u32, height: u32, width_method: WidthMethod) -> Result<Self> {
        Self::create(context, width, height, width_method, 0)
    }

    /// Like [`Self::new`], but drawing the buffer elsewhere blends its cells over the ones below by their alpha, so
    /// a transparent background shows what is under it. Core calls these `respectAlpha` buffers.
    pub fn with_alpha(context: &Context, width: u32, height: u32, width_method: WidthMethod) -> Result<Self> {
        Self::create(context, width, height, width_method, sys::OT_BUFFER_RESPECT_ALPHA)
    }

    fn create(context: &Context, width: u32, height: u32, width_method: WidthMethod, flags: u32) -> Result<Self> {
        let options =
            sys::ot_buffer_options { width, height, width_method: width_method.raw(), flags, ..Default::default() };
        let resource = Resource::create(
            context,
            "ot_buffer_create",
            ("ot_buffer_destroy", sys::ot_buffer_destroy),
            |context, handle| unsafe { sys::ot_buffer_create(context, &options, handle) },
        )?;
        Ok(Self(Rc::new(BufferInner { resource, size: Cell::new((width, height)) })))
    }

    pub fn context(&self) -> &Context {
        self.0.resource.context()
    }

    pub(crate) fn handle(&self) -> sys::ot_handle {
        self.0.resource.handle()
    }

    fn raw(&self) -> (*mut sys::ot_context, *const sys::ot_handle) {
        self.0.resource.raw()
    }

    /// The width and height in cells.
    pub fn size(&self) -> (u32, u32) {
        self.0.size.get()
    }

    /// Changes the size. A new size clears every cell; the same size changes nothing.
    pub fn resize(&self, width: u32, height: u32) -> Result<()> {
        let (context, handle) = self.raw();
        check("ot_buffer_resize", unsafe { sys::ot_buffer_resize(context, handle, width, height) })?;
        self.0.size.set((width, height));
        Ok(())
    }

    fn draw<T: Pod>(&self, record: &T, source: Option<&Buffer>, text: &[u8], bottom: &[u8]) -> Result<()> {
        records::check_text(text, bottom)?;
        let source = source.map(Buffer::handle);
        let (context, handle) = self.raw();
        // Every draw record starts with its ot_buffer_draw_header.
        let header = (record as *const T).cast::<sys::ot_buffer_draw_header>();
        check("ot_buffer_draw", unsafe {
            sys::ot_buffer_draw(
                context,
                handle,
                std::ptr::null(),
                header,
                source.as_ref().map_or(std::ptr::null(), |source| source),
                text.as_ptr(),
                text.len() as u32,
                bottom.as_ptr(),
                bottom.len() as u32,
            )
        })
    }

    /// Fills every cell with a space on `background`, with no attributes.
    pub fn clear(&self, background: Color) -> Result<()> {
        self.draw(&records::clear(background), None, &[], &[])
    }

    /// Fills a rectangle with a background color, keeping its characters.
    pub fn fill(&self, x: i32, y: i32, width: u32, height: u32, background: Color) -> Result<()> {
        self.draw(&records::fill(x, y, width, height, background), None, &[], &[])
    }

    /// Draws one row of text. A missing foreground uses the terminal's default; a missing background keeps the
    /// cells' existing background.
    pub fn text(&self, x: i32, y: i32, text: &str, style: Style) -> Result<()> {
        self.draw(&records::text(x, y, style), None, text.as_bytes(), &[])
    }

    /// Draws one single-cell character, replacing the cell.
    pub fn cell(&self, x: i32, y: i32, character: char, style: Style) -> Result<()> {
        self.draw(&records::cell(x, y, character, style, false), None, &[], &[])
    }

    pub fn draw_box(&self, x: i32, y: i32, width: u32, height: u32, spec: &BoxSpec<'_>) -> Result<()> {
        let record = records::draw_box(x, y, width, height, spec);
        self.draw(&record, None, spec.title.as_bytes(), spec.bottom_title.as_bytes())
    }

    /// Copies all of `source`'s cells into this buffer with their top-left cell at a position. Both buffers must
    /// belong to the same Context, and a buffer cannot draw into itself.
    pub fn compose(&self, source: &Buffer, x: i32, y: i32) -> Result<()> {
        self.draw(&records::compose(x, y), Some(source), &[], &[])
    }

    /// Copies the cells.
    pub fn capture(&self) -> Result<Capture> {
        let mut snapshot = sys::ot_buffer_lease_snapshot::default();
        let (context, handle) = self.raw();
        check("ot_buffer_acquire_lease", unsafe { sys::ot_buffer_acquire_lease(context, handle, &mut snapshot) })?;
        Lease { context, snapshot }.capture()
    }
}

impl Node {
    /// Shows a buffer's cells at a [`NodeKind::Custom`](super::NodeKind::Custom) node's position each frame, or stops
    /// with `None`. The scene keeps the buffer alive while it is bound.
    pub fn set_surface(&self, buffer: Option<&Buffer>) -> Result<()> {
        let buffer = buffer.map(Buffer::handle);
        check("ot_scene_set_surface", unsafe {
            sys::ot_scene_set_surface(
                self.context_raw(),
                &self.handle(),
                buffer.as_ref().map_or(std::ptr::null(), |buffer| buffer),
            )
        })
    }
}
