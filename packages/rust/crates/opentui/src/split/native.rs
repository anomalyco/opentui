//! Safe wrappers over the split-footer calls of the C ABI.

use crate::error::{Error, Result, Status, check, count};
use crate::native::{Buffer, Draft, RenderOutcome, Session};
use crate::sys;

/// The most snapshots one [`Session::render_split`] call takes.
pub const SPLIT_SNAPSHOTS_MAX: usize = sys::OT_SPLIT_SNAPSHOTS_MAX as usize;

/// One block of rows to append to the scrollback above the footer.
#[derive(Clone, Debug)]
pub struct SplitSnapshot {
    /// The rows. It must belong to the Session's Context.
    pub buffer: Buffer,
    /// Columns of each row to write, from the left: at most the buffer's width.
    pub row_columns: u32,
    /// Start on a new row when the previous snapshot ended inside one.
    pub start_on_new_line: bool,
    /// End the last row with a newline.
    pub trailing_newline: bool,
}

/// How a footer transition moves the surface rows it leaves.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub enum TransitionMode {
    /// Scroll the viewport up by the transition's scroll rows.
    ViewportScroll,
    /// Clear the rows the old surface covered and the new one does not.
    ClearStaleRows,
}

/// A footer move the next split frame applies, in one-based terminal rows.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub struct SplitTransition {
    pub mode: TransitionMode,
    pub source_top: u32,
    pub source_height: u32,
    pub target_top: u32,
    pub target_height: u32,
    pub scroll_rows: u32,
}

/// A command for [`Session::split_control`]. Each returns a row offset; see the variants.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub enum SplitControl {
    /// Forgets the scrollback and starts again `seed_rows` rows down the screen, where the cursor is. Returns the
    /// surface's render offset.
    Reset { seed_rows: u32, pinned_render_offset: u32 },
    /// Settles the scrollback bookkeeping against a footer pinned at `pinned_render_offset`. Returns the surface's
    /// render offset.
    Sync { pinned_render_offset: u32 },
    /// The output offset that matches a surface offset.
    OutputOffset { surface_offset: u32 },
    /// Moves the surface. Returns zero.
    RenderOffset { offset: u32 },
    /// Defers a footer move to the next split frame. Until then, ordinary frames, setup, and resume are busy.
    Transition(SplitTransition),
    /// Drops a deferred transition.
    ClearTransition,
}

impl SplitControl {
    fn encode(self) -> sys::ot_split_control {
        let (command, arguments) = match self {
            Self::Reset { seed_rows, pinned_render_offset } => (0, [seed_rows, pinned_render_offset, 0, 0, 0, 0]),
            Self::Sync { pinned_render_offset } => (1, [pinned_render_offset, 0, 0, 0, 0, 0]),
            Self::OutputOffset { surface_offset } => (2, [surface_offset, 0, 0, 0, 0, 0]),
            Self::RenderOffset { offset } => (3, [offset, 0, 0, 0, 0, 0]),
            Self::Transition(transition) => (
                4,
                [
                    match transition.mode {
                        TransitionMode::ViewportScroll => 1,
                        TransitionMode::ClearStaleRows => 2,
                    },
                    transition.source_top,
                    transition.source_height,
                    transition.target_top,
                    transition.target_height,
                    transition.scroll_rows,
                ],
            ),
            Self::ClearTransition => (5, [0; 6]),
        };
        sys::ot_split_control { command, arguments, ..Default::default() }
    }
}

impl Session {
    /// Appends `snapshots` to the scrollback and presents `draft` as the footer, in one frame. Without a draft, only
    /// the snapshots go out; `Pending` may then describe an earlier frame, and no snapshot was taken.
    ///
    /// Every `Ok` consumes the draft, whatever the outcome. An `Err` leaves it live for a retry.
    pub fn render_split(
        &self,
        draft: Option<&mut Draft>,
        snapshots: &[SplitSnapshot],
        pinned_render_offset: u32,
        force: bool,
    ) -> Result<RenderOutcome> {
        const OPERATION: &str = "ot_session_render_split";
        if snapshots.len() > SPLIT_SNAPSHOTS_MAX {
            return Err(Error::Native { operation: OPERATION, status: Status::InvalidArgument });
        }
        let request = match &draft {
            Some(draft) => {
                Some(*draft.raw().ok_or(Error::Native { operation: OPERATION, status: Status::StaleFrame })?)
            }
            None => None,
        };
        let raw: Vec<sys::ot_split_snapshot> = snapshots
            .iter()
            .map(|snapshot| sys::ot_split_snapshot {
                buffer: snapshot.buffer.handle(),
                row_columns: snapshot.row_columns,
                flags: u32::from(snapshot.start_on_new_line) | (u32::from(snapshot.trailing_newline) << 1),
            })
            .collect();
        let mut outcome = 0;
        let session = self.handle();
        check(OPERATION, unsafe {
            sys::ot_session_render_split(
                self.context().as_raw(),
                &session,
                request.as_ref().map_or(std::ptr::null(), |request| request),
                if raw.is_empty() { std::ptr::null() } else { raw.as_ptr() },
                raw.len() as u32,
                pinned_render_offset,
                u32::from(force),
                &mut outcome,
            )
        })?;
        if let Some(draft) = draft {
            draft.consume();
        }
        RenderOutcome::from_raw(outcome)
    }

    /// Runs a split scrollback command and returns its row offset.
    pub fn split_control(&self, control: SplitControl) -> Result<u32> {
        let raw = control.encode();
        let mut offset = 0;
        let session = self.handle();
        check("ot_session_split_control", unsafe {
            sys::ot_session_split_control(self.context().as_raw(), &session, &raw, &mut offset)
        })?;
        Ok(offset)
    }

    /// Changes the screen mode and the renderer size together, writing `trailing_output` after the mode change. The
    /// mode packet and the output must fit in 4096 bytes.
    pub fn set_screen(&self, alternate: bool, width: u32, height: u32, trailing_output: &[u8]) -> Result<()> {
        let length = count("ot_session_set_screen", trailing_output.len())?;
        let session = self.handle();
        check("ot_session_set_screen", unsafe {
            sys::ot_session_set_screen(
                self.context().as_raw(),
                &session,
                u32::from(alternate),
                width,
                height,
                trailing_output.as_ptr(),
                length,
            )
        })
    }

    /// Copies a parent Session's detected terminal state, such as its width method, into this detached one.
    pub fn sync_detached(&self, parent: &Session) -> Result<()> {
        let (session, parent) = (self.handle(), parent.handle());
        check("ot_session_sync_detached", unsafe {
            sys::ot_session_sync_detached(self.context().as_raw(), &session, &parent)
        })
    }

    /// The one-based row of the terminal cursor native code knows, from setup's cursor report or the last frame.
    pub(crate) fn cursor_row(&self) -> Result<u32> {
        let mut state = sys::ot_scene_cursor_state::default();
        let session = self.handle();
        check("ot_scene_get_cursor_state", unsafe {
            sys::ot_scene_get_cursor_state(self.context().as_raw(), &session, &mut state)
        })?;
        Ok(state.y)
    }
}

impl Draft {
    /// Copies the painted cells into `target`, a buffer of the frame's size in the same Context, without presenting
    /// them.
    pub fn copy_to(&self, target: &Buffer) -> Result<()> {
        const OPERATION: &str = "ot_scene_frame_copy_buffer";
        let request = *self.raw().ok_or(Error::Native { operation: OPERATION, status: Status::StaleFrame })?;
        let (session, buffer) = (self.session().handle(), target.handle());
        check(OPERATION, unsafe {
            sys::ot_scene_frame_copy_buffer(target.context().as_raw(), &session, &request, &buffer)
        })
    }
}
