use super::{Recorder, Session};
use crate::error::{Error, Result, check};
use crate::layout::Rect;
use crate::post::ColorMatrix;
use crate::style::{Attributes, Color};
use crate::sys;

/// The result of submitting a frame. Every outcome consumes the draft.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum RenderOutcome {
    /// Accepted, and presentation is already complete.
    Presented,
    /// Accepted; presentation completes when its output is delivered.
    Pending,
    /// Output pressure: nothing was accepted. Paint a new frame after queued output drains.
    Skipped,
    /// The frame did not fit the empty queue, or encoding failed. Nothing was accepted.
    Failed,
}

impl RenderOutcome {
    pub(crate) fn from_raw(raw: u32) -> Result<Self> {
        Ok(match raw {
            sys::OT_RENDER_PRESENTED => Self::Presented,
            sys::OT_RENDER_PENDING => Self::Pending,
            sys::OT_RENDER_SKIPPED => Self::Skipped,
            sys::OT_RENDER_FAILED => Self::Failed,
            _ => return Err(Error::Usage("native renderer returned an unknown render outcome")),
        })
    }

    /// Whether native code accepted the frame's output.
    pub fn accepted(self) -> bool {
        matches!(self, Self::Presented | Self::Pending)
    }
}

/// Frame hooks a node registers with [`Node::set_hooks`](super::Node::set_hooks).
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Hash)]
pub struct Hooks(u32);

impl Hooks {
    pub const NONE: Self = Self(0);
    /// An update request each frame, before layout settles.
    pub const UPDATE: Self = Self(sys::OT_SCENE_HOOK_UPDATE);
    /// A request when the node's size changes.
    pub const RESIZE: Self = Self(sys::OT_SCENE_HOOK_RESIZE);
    /// Root only: a request after each actual layout solve.
    pub const LAYOUT_CHANGED: Self = Self(sys::OT_SCENE_HOOK_LAYOUT_CHANGED);
    pub const RENDER_BEFORE: Self = Self(sys::OT_SCENE_HOOK_RENDER_BEFORE);
    pub const RENDER_AFTER: Self = Self(sys::OT_SCENE_HOOK_RENDER_AFTER);
    /// Replace the node's native body with recorded drawing.
    pub const RENDER_SELF: Self = Self(sys::OT_SCENE_HOOK_RENDER_SELF);
    pub const IDLE_UPDATE: Self = Self(sys::OT_SCENE_HOOK_IDLE_UPDATE);
    /// Scroll nodes only (`sys::ot_scene_set_scroll`): a request when the scroll state changed since the last one.
    pub const SCROLL: Self = Self(sys::OT_SCENE_HOOK_SCROLL);

    pub const fn bits(self) -> u32 {
        self.0
    }

    pub const fn from_bits(bits: u32) -> Self {
        Self(bits)
    }

    pub const fn contains(self, other: Self) -> bool {
        self.0 & other.0 == other.0
    }

    pub const fn union(self, other: Self) -> Self {
        Self(self.0 | other.0)
    }

    pub const fn is_empty(self) -> bool {
        self.0 == 0
    }
}

impl std::ops::BitOr for Hooks {
    type Output = Self;
    fn bitor(self, other: Self) -> Self {
        self.union(other)
    }
}

/// Options for one frame attempt.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct FrameOptions {
    /// Color for cells nothing paints.
    pub background: Color,
    /// Record each painted node's rectangle for [`Session::hit_test`].
    pub hit_grid: bool,
    /// A node number excluded from this frame's hits, such as a node being dragged. Zero excludes nothing.
    pub excluded_hit: u32,
    pub max_layout_rounds: u32,
    pub max_host_requests: u32,
    /// Leave cells nothing paints empty (code point zero) instead of spaces, as offscreen snapshots need: a split
    /// footer does not write a row's trailing empty cells to the scrollback.
    pub preserve_unwritten: bool,
}

impl Default for FrameOptions {
    fn default() -> Self {
        Self {
            background: Color::TRANSPARENT,
            hit_grid: true,
            excluded_hit: 0,
            max_layout_rounds: 8,
            max_host_requests: 65_536,
            preserve_unwritten: false,
        }
    }
}

/// One node whose paint hooks a frame asks the host to record.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct PaintSlot {
    /// The slot's index for [`Recorder::begin`].
    pub index: u32,
    pub node: sys::ot_handle,
    pub num: u32,
    /// The paint hooks to record.
    pub hooks: Hooks,
    /// Clip rectangle: x, y, width, height.
    pub clip: (i32, i32, u32, u32),
    pub opacity: f32,
    /// The geometry native code paints the node at.
    pub paint: Rect,
}

/// Work a frame attempt asks the host to do before it continues.
pub enum HostRequest<'a> {
    /// Run the node's update work.
    Update { node: sys::ot_handle, num: u32 },
    /// The node's size changed.
    Resize { node: sys::ot_handle, num: u32, width: u32, height: u32 },
    /// The root's layout was solved again.
    LayoutChanged { width: u32, height: u32 },
    /// Record every slot's hooks, in slot order.
    Record { slots: &'a [PaintSlot], recorder: &'a mut Recorder },
    /// A scroll node's offset, content size, or viewport size changed since the last request, or a layout callback
    /// it asked for is due. `sys::ot_scene_get_scroll` reads the state and what changed.
    Scroll { node: sys::ot_handle, num: u32 },
}

/// A painted frame that has not been submitted. Dropping it cancels the frame.
#[must_use = "commit the draft to present it; dropping it cancels the frame"]
pub struct Draft {
    session: Session,
    request: Option<sys::ot_scene_frame_request>,
}

impl Drop for Draft {
    fn drop(&mut self) {
        if let Some(request) = self.request.take() {
            let session = self.session.handle();
            let status =
                unsafe { sys::ot_scene_frame_cancel(self.session.context().as_raw(), &session, request.frame_id) };
            // Session shutdown may already have cancelled the draft.
            if status != sys::OT_STALE_FRAME {
                crate::error::cleanup("ot_scene_frame_cancel", status);
            }
        }
    }
}

impl Draft {
    fn live(&self, operation: &'static str) -> Result<&sys::ot_scene_frame_request> {
        self.request.as_ref().ok_or(Error::Native { operation, status: crate::Status::StaleFrame })
    }

    /// Submits the frame. Every `Ok` consumes the draft, whatever the outcome. An `Err` keeps it for a retry.
    pub fn commit(&mut self, force: bool) -> Result<RenderOutcome> {
        let request = *self.live("ot_scene_frame_commit")?;
        let mut outcome = 0;
        let session = self.session.handle();
        check("ot_scene_frame_commit", unsafe {
            sys::ot_scene_frame_commit(
                self.session.context().as_raw(),
                &session,
                &request,
                u32::from(force),
                &mut outcome,
            )
        })?;
        self.request = None;
        RenderOutcome::from_raw(outcome)
    }

    /// Whether the draft can still be committed or captured.
    pub fn is_live(&self) -> bool {
        self.request.is_some()
    }

    pub fn raw(&self) -> Option<&sys::ot_scene_frame_request> {
        self.request.as_ref()
    }

    /// Marks the draft as submitted by another native call, such as a split render, so dropping it cancels nothing.
    pub(crate) fn consume(&mut self) {
        self.request = None;
    }

    pub(crate) fn session(&self) -> &Session {
        &self.session
    }

    /// Copies the painted cells. Like any access to them, this makes the next frame repaint in full.
    pub fn capture(&self) -> Result<Capture> {
        self.lease()?.capture()
    }

    /// Leases the painted cells for direct access. Release the lease before committing.
    pub(crate) fn lease(&self) -> Result<Lease> {
        let request = *self.live("ot_scene_frame_acquire_buffer_lease")?;
        let mut snapshot = sys::ot_buffer_lease_snapshot::default();
        let session = self.session.handle();
        let context = self.session.context().as_raw();
        check("ot_scene_frame_acquire_buffer_lease", unsafe {
            sys::ot_scene_frame_acquire_buffer_lease(
                context,
                &session,
                &request,
                sys::OT_SESSION_BUFFER_NEXT,
                &mut snapshot,
            )
        })?;
        Ok(Lease { context, snapshot })
    }

    /// Transforms the painted colors with a matrix. `mask` holds `(x, y, weight)` triples, each weight scaling the
    /// matrix's strength; `None` transforms every cell. Cells outside the frame are skipped.
    pub fn color_matrix(&self, matrix: &ColorMatrix, mask: Option<&[f32]>) -> Result<()> {
        const OPERATION: &str = "ot_buffer_color_matrix";
        let request = *self.live(OPERATION)?;
        let (mask_ptr, mask_count) = match mask {
            Some(mask) => (mask.as_ptr(), crate::error::count(OPERATION, mask.len())?),
            None => (std::ptr::null(), 0),
        };
        let flat = matrix.flat();
        let session = self.session.handle();
        check(OPERATION, unsafe {
            sys::ot_buffer_color_matrix(
                self.session.context().as_raw(),
                &session,
                &request,
                flat.as_ptr(),
                16,
                mask_ptr,
                mask_count,
                &matrix.strength,
                matrix.channels.raw(),
            )
        })
    }

    /// Draws a rectangle of packed cells at a cell position: per cell, background then foreground as four `f32`
    /// channels each, a `u32` character, and 12 padding bytes, all native-endian (48 bytes). Characters other than
    /// printable ASCII and single-width block and border glyphs draw as a block. Opaque colors replace the cells,
    /// including their attributes.
    pub fn draw_packed(&self, cells: &[u8], x: i32, y: i32, width: u32, height: u32) -> Result<()> {
        const OPERATION: &str = "ot_buffer_draw_packed";
        let request = *self.live(OPERATION)?;
        let session = self.session.handle();
        check(OPERATION, unsafe {
            sys::ot_buffer_draw_packed(
                self.session.context().as_raw(),
                &session,
                &request,
                cells.as_ptr(),
                crate::error::count(OPERATION, cells.len())?,
                x,
                y,
                width,
                height,
            )
        })
    }
}

/// One captured cell.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Cell {
    /// The cell's grapheme. Empty for the trailing cells of a wide grapheme.
    pub symbol: String,
    pub fg: Color,
    pub bg: Color,
    pub attributes: Attributes,
}

/// A copy of a frame's cells.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Capture {
    pub width: u32,
    pub height: u32,
    pub cells: Vec<Cell>,
}

impl Capture {
    /// The cell at column `x` and row `y`, or `None` outside the capture.
    pub fn cell(&self, x: u32, y: u32) -> Option<&Cell> {
        if x >= self.width || y >= self.height {
            return None;
        }
        let index = (y as usize).checked_mul(self.width as usize)?.checked_add(x as usize)?;
        self.cells.get(index)
    }

    /// One row's text, with trailing spaces kept. Empty outside the capture.
    pub fn row(&self, y: u32) -> String {
        let width = self.width as usize;
        let start = (y < self.height).then(|| (y as usize).checked_mul(width)).flatten();
        start
            .and_then(|start| self.cells.get(start..start.checked_add(width)?))
            .map_or(String::new(), |row| row.iter().map(|cell| cell.symbol.as_str()).collect())
    }

    /// Every row's text joined with newlines, with trailing spaces removed from each row.
    pub fn text(&self) -> String {
        (0..self.height).map(|y| self.row(y).trim_end().to_owned()).collect::<Vec<_>>().join("\n")
    }
}

/// Shows [`Capture::text`].
impl std::fmt::Display for Capture {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter.write_str(&self.text())
    }
}

/// A checked storage lease, released on drop.
pub(crate) struct Lease {
    pub context: *mut sys::ot_context,
    pub snapshot: sys::ot_buffer_lease_snapshot,
}

impl Drop for Lease {
    fn drop(&mut self) {
        crate::error::cleanup("ot_buffer_lease_release", unsafe {
            sys::ot_buffer_lease_release(self.context, &self.snapshot.lease)
        });
    }
}

/// A lease's cell planes, row-major, `width * height` cells. Colors hold four `u16` words per cell (RGBA bytes in
/// the low bytes, color intent in the high bytes). Plain characters are Unicode scalars; other values name pooled
/// graphemes, their continuation cells, or image cells, which must not be replaced through these planes.
pub(crate) struct Planes<'a> {
    pub width: u32,
    pub height: u32,
    pub chars: &'a mut [u32],
    pub fg: &'a mut [u16],
    pub bg: &'a mut [u16],
    pub attributes: &'a mut [u32],
}

impl Lease {
    pub(crate) fn planes(&mut self) -> Planes<'_> {
        let (width, height) = (self.snapshot.width, self.snapshot.height);
        let cells = width as usize * height as usize;
        // SAFETY: the live lease keeps four distinct planes allocated with the documented element counts, and the
        // mutable borrow of the lease keeps these slices unique on the Rust side.
        unsafe {
            Planes {
                width,
                height,
                chars: std::slice::from_raw_parts_mut(self.snapshot.char_ptr as usize as *mut u32, cells),
                fg: std::slice::from_raw_parts_mut(self.snapshot.fg_ptr as usize as *mut u16, cells * 4),
                bg: std::slice::from_raw_parts_mut(self.snapshot.bg_ptr as usize as *mut u16, cells * 4),
                attributes: std::slice::from_raw_parts_mut(self.snapshot.attributes_ptr as usize as *mut u32, cells),
            }
        }
    }

    pub(crate) fn capture(&self) -> Result<Capture> {
        let (width, height) = (self.snapshot.width, self.snapshot.height);
        let cells = width as usize * height as usize;
        let mut size = 0;
        check("ot_buffer_lease_get_real_char_size", unsafe {
            sys::ot_buffer_lease_get_real_char_size(self.context, &self.snapshot.lease, 0, &mut size)
        })?;
        let mut bytes = vec![0u8; size as usize];
        let mut lengths = vec![0u8; cells];
        let mut written = 0;
        check("ot_buffer_lease_write_resolved_chars", unsafe {
            sys::ot_buffer_lease_write_resolved_chars(
                self.context,
                &self.snapshot.lease,
                bytes.as_mut_ptr(),
                size,
                0,
                lengths.as_mut_ptr(),
                cells as u32,
                &mut written,
            )
        })?;
        bytes.truncate(written as usize);
        // SAFETY: the live lease keeps these planes allocated with the documented element counts.
        let (fg, bg, attributes) = unsafe {
            (
                std::slice::from_raw_parts(self.snapshot.fg_ptr as usize as *const u16, cells * 4),
                std::slice::from_raw_parts(self.snapshot.bg_ptr as usize as *const u16, cells * 4),
                std::slice::from_raw_parts(self.snapshot.attributes_ptr as usize as *const u32, cells),
            )
        };
        let mut offset = 0;
        let mut captured = Vec::with_capacity(cells);
        for (index, &length) in lengths.iter().enumerate() {
            let end = (offset + length as usize).min(bytes.len());
            let symbol = String::from_utf8_lossy(&bytes[offset..end]).into_owned();
            offset = end;
            let color = |plane: &[u16]| Color::from_raw(plane[index * 4..index * 4 + 4].try_into().unwrap());
            captured.push(Cell {
                symbol,
                fg: color(fg),
                bg: color(bg),
                attributes: Attributes::from_bits(attributes[index] as u8),
            });
        }
        Ok(Capture { width, height, cells: captured })
    }
}

impl Session {
    /// Paints a scene without host hooks and keeps the result as a [`Draft`].
    pub fn paint(&self, background: Color, hit_grid: bool, excluded_hit: u32) -> Result<Draft> {
        let mut request = sys::ot_scene_frame_request::default();
        let session = self.handle();
        let background = background.to_raw();
        check("ot_scene_paint", unsafe {
            sys::ot_scene_paint(
                self.context().as_raw(),
                &session,
                background.as_ptr(),
                u32::from(hit_grid),
                excluded_hit,
                &mut request,
            )
        })?;
        Ok(Draft { session: self.clone(), request: Some(request) })
    }

    /// Copies the presented cells. Unlike [`Draft::capture`], this lets the next frame keep the cells that did not
    /// change. Fails while a frame is in progress or its output is pending.
    pub(crate) fn capture_presented(&self) -> Result<Capture> {
        let mut snapshot = sys::ot_buffer_lease_snapshot::default();
        let session = self.handle();
        let context = self.context().as_raw();
        check("ot_session_acquire_buffer_lease", unsafe {
            sys::ot_session_acquire_buffer_lease(context, &session, sys::OT_SESSION_BUFFER_CURRENT, &mut snapshot)
        })?;
        Lease { context, snapshot }.capture()
    }

    /// Prepares and paints a frame, calling `host` for every hook request in order.
    ///
    /// Hooks run between native calls, before any cell is painted. A host error cancels the attempt; accepted scene
    /// changes stay.
    pub fn frame(&self, options: &FrameOptions, mut host: impl FnMut(HostRequest<'_>) -> Result<()>) -> Result<Draft> {
        let raw_options = sys::ot_scene_frame_options {
            background: options.background.to_raw(),
            use_mouse: u32::from(options.hit_grid),
            excluded_hit_num: options.excluded_hit,
            max_layout_rounds: options.max_layout_rounds,
            max_host_requests: options.max_host_requests,
            preserve_unwritten: u32::from(options.preserve_unwritten),
            ..Default::default()
        };
        let context = self.context().as_raw();
        let session = self.handle();
        let mut attempt = Attempt { session: self, frame_id: None };
        let mut previous: Option<sys::ot_scene_frame_request> = None;
        let mut recorder = Recorder::new();
        let mut recorded = false;
        let mut slots = Vec::new();
        // Native code bounds hook requests by max_host_requests; this only guards the loop itself.
        for _ in 0..=u64::from(options.max_host_requests) + 2 {
            let mut request = sys::ot_scene_frame_request::default();
            let mut geometry = sys::ot_scene_frame_geometry::default();
            let recording: &[u8] = if recorded { recorder.bytes() } else { &[] };
            let status = unsafe {
                sys::ot_scene_frame_step_with_geometry(
                    context,
                    &session,
                    previous.as_ref().map_or(std::ptr::null(), |previous| previous as *const _),
                    &raw_options,
                    if recording.is_empty() { std::ptr::null() } else { recording.as_ptr() },
                    recording.len() as u32,
                    &mut request,
                    &mut geometry,
                )
            };
            check("ot_scene_frame_step_with_geometry", status)?;
            attempt.frame_id = Some(request.frame_id);
            recorded = false;
            match request.kind {
                sys::OT_SCENE_FRAME_DONE => {
                    attempt.frame_id = None;
                    return Ok(Draft { session: self.clone(), request: Some(request) });
                }
                sys::OT_SCENE_FRAME_UPDATE => host(HostRequest::Update { node: request.node, num: request.num })?,
                sys::OT_SCENE_FRAME_RESIZE => host(HostRequest::Resize {
                    node: request.node,
                    num: request.num,
                    width: request.width,
                    height: request.height,
                })?,
                sys::OT_SCENE_FRAME_LAYOUT_CHANGED => {
                    host(HostRequest::LayoutChanged { width: request.width, height: request.height })?
                }
                sys::OT_SCENE_FRAME_RECORD => {
                    read_slots(self, &request, &mut slots)?;
                    recorder.reset();
                    host(HostRequest::Record { slots: &slots, recorder: &mut recorder })?;
                    recorded = !recorder.is_empty();
                }
                sys::OT_SCENE_FRAME_SCROLL => host(HostRequest::Scroll { node: request.node, num: request.num })?,
                _ => return Err(Error::Usage("native scene returned an unknown frame request")),
            }
            previous = Some(request);
        }
        Err(Error::Usage("frame attempt exceeded its host request bound"))
    }

    /// Submits immediate drawing without a scene draft. `Pending` can describe an earlier submission. The frame has
    /// no scene hits: [`Self::hit_test`] finds nothing until a scene frame presents.
    pub fn render(&self, force: bool) -> Result<RenderOutcome> {
        let mut outcome = 0;
        let session = self.handle();
        check("ot_session_render", unsafe {
            sys::ot_session_render(self.context().as_raw(), &session, u32::from(force), &mut outcome)
        })?;
        RenderOutcome::from_raw(outcome)
    }
}

fn read_slots(session: &Session, request: &sys::ot_scene_frame_request, slots: &mut Vec<PaintSlot>) -> Result<()> {
    let context = session.context().as_raw();
    let handle = session.handle();
    let mut total = 0;
    check("ot_scene_frame_get_paint_slots", unsafe {
        sys::ot_scene_frame_get_paint_slots(context, &handle, request, std::ptr::null_mut(), 0, &mut total)
    })?;
    let mut raw = vec![sys::ot_scene_paint_slot::default(); total as usize];
    check("ot_scene_frame_get_paint_slots", unsafe {
        sys::ot_scene_frame_get_paint_slots(context, &handle, request, raw.as_mut_ptr(), total, &mut total)
    })?;
    raw.truncate(total as usize);
    slots.clear();
    slots.extend(raw.iter().enumerate().map(|(index, slot)| PaintSlot {
        index: index as u32,
        node: slot.node,
        num: slot.num,
        hooks: Hooks(slot.hooks),
        clip: (slot.clip_x, slot.clip_y, slot.clip_width, slot.clip_height),
        opacity: slot.opacity,
        paint: Rect::from_raw(&slot.paint),
    }));
    Ok(())
}

/// Cancels an unfinished frame attempt when the driver returns early.
struct Attempt<'a> {
    session: &'a Session,
    frame_id: Option<u64>,
}

impl Drop for Attempt<'_> {
    fn drop(&mut self) {
        if let Some(frame_id) = self.frame_id {
            let session = self.session.handle();
            // Failed steps already cancel natively, so a stale frame here is expected.
            let _ = unsafe { sys::ot_scene_frame_cancel(self.session.context().as_raw(), &session, frame_id) };
        }
    }
}
