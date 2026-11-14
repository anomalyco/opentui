//! The split-footer state machine, ported from Core's `CliRenderer` in `screenMode: "split-footer"` with
//! `externalOutputMode: "capture-stdout"`.

use super::native::{SplitControl, SplitSnapshot, SplitTransition, TransitionMode};
use crate::error::{Error, Result, Status};
use crate::native::{Draft, Lease, RenderOutcome, Session};
use crate::sys;
use std::cell::RefCell;
use std::collections::VecDeque;
use std::rc::Rc;
use std::time::{Duration, Instant};

/// Snapshots one frame appends at most, as in Core.
const COMMITS_PER_FRAME: usize = 8;
/// Bytes of Session output one snapshot cell may take, as Core counts them.
const BYTES_PER_CELL: u64 = 24;
/// How long the first frame waits for the cursor report that places the footer, as in Core.
const SEED_WAIT: Duration = Duration::from_millis(120);

thread_local! {
    /// Footers by Session. An entry keeps its footer, which keeps its Session, until nothing else refers to either.
    static FOOTERS: RefCell<Vec<(sys::ot_handle, Rc<RefCell<State>>)>> = const { RefCell::new(Vec::new()) };
}

/// Drops the footers nothing outside the registry uses: neither the footer nor its Session has another handle.
fn prune(footers: &mut Vec<(sys::ot_handle, Rc<RefCell<State>>)>) {
    footers.retain(|(_, footer)| {
        Rc::strong_count(footer) > 1 || footer.try_borrow().map_or(true, |state| state.session.references() > 1)
    });
}

/// A footer kept at the bottom of the main screen, with scrollback written above it.
///
/// The renderer covers only the footer's rows. [`Self::write`] queues rows for the scrollback; the next frame appends
/// them above the footer and repaints the footer in one write, so the footer does not flicker. A
/// [`Host`](crate::host::Host) started with [`HostOptions::split_footer`](crate::host::HostOptions::split_footer)
/// creates one and drives it; [`Self::of`] finds it for a Session.
///
/// Cloning shares the same footer.
#[derive(Clone)]
pub struct SplitFooter(Rc<RefCell<State>>);

impl std::fmt::Debug for SplitFooter {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        let state = self.0.borrow();
        formatter
            .debug_struct("SplitFooter")
            .field("terminal", &state.terminal)
            .field("footer_height", &state.footer_height)
            .field("queued", &state.queue.len())
            .finish_non_exhaustive()
    }
}

/// A queued snapshot with what tail-column predictions read from it once.
struct Queued {
    snapshot: SplitSnapshot,
    cells: u64,
    row_widths: Vec<u32>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum Mode {
    Split(u32),
    Main,
}

/// A replay reset waiting for the snapshots queued before it.
#[derive(Clone, Copy)]
struct Replay {
    clear_saved_lines: bool,
    remaining: usize,
}

/// What one step of draining the queue without a footer frame did.
pub(crate) enum Drain {
    /// Nothing is queued.
    Done,
    /// Output must drain first.
    Wait,
    /// Snapshots went out.
    Submitted,
}

struct State {
    session: Session,
    terminal: (u32, u32),
    /// The requested footer height, and the rows it gets: at most the terminal's height, and 0 once left.
    footer_height: u32,
    split_height: u32,
    render_offset: u32,
    queue: VecDeque<Queued>,
    /// The column where the last appended row ended.
    tail_column: u32,
    /// Snapshots an accepted split frame took, waiting for its presentation.
    accepted: Option<usize>,
    commit_limit: usize,
    max_cells: u64,
    transition: Option<SplitTransition>,
    pending_mode: Option<Mode>,
    replay: Option<Replay>,
    /// A late cursor report can still place the footer after the first frame's wait ends.
    seed_pending: bool,
    seed_until: Option<Instant>,
    /// The terminal is set up and not suspended.
    writable: bool,
    force: bool,
    /// The renderer size changed outside a terminal resize.
    resized: Option<(u32, u32)>,
}

impl SplitFooter {
    /// A footer of `footer_height` rows on a `terminal` of that size, for a Session whose renderer is already
    /// [`Self::renderer_size`]. [`Host`](crate::host::Host) calls this; use [`Self::of`] to find the footer.
    pub(crate) fn new(session: &Session, terminal: (u16, u16), footer_height: u16) -> Result<Self> {
        let footer_height = u32::from(footer_height.max(1));
        let terminal = (u32::from(terminal.0), u32::from(terminal.1));
        let max_cells = session.write_limit()? / BYTES_PER_CELL;
        let footer = Self(Rc::new(RefCell::new(State {
            session: session.clone(),
            terminal,
            footer_height,
            split_height: footer_height.min(terminal.1),
            render_offset: 0,
            queue: VecDeque::new(),
            tail_column: 0,
            accepted: None,
            commit_limit: COMMITS_PER_FRAME,
            max_cells,
            transition: None,
            pending_mode: None,
            replay: None,
            seed_pending: false,
            seed_until: None,
            writable: false,
            force: false,
            resized: None,
        })));
        let handle = session.handle();
        FOOTERS.with(|footers| {
            let mut footers = footers.borrow_mut();
            prune(&mut footers);
            footers.push((handle, footer.0.clone()));
        });
        Ok(footer)
    }

    /// The terminal the Session is attached to has `terminal` cells; the renderer already fits it.
    pub(crate) fn attached(&self, terminal: (u16, u16)) {
        let mut state = self.0.borrow_mut();
        state.terminal = (u32::from(terminal.0), u32::from(terminal.1));
        if state.split_height > 0 {
            state.split_height = state.footer_height.min(state.terminal.1);
        }
    }

    /// The footer of a Session started with [`HostOptions::split_footer`](crate::host::HostOptions::split_footer),
    /// such as [`App::session`](crate::App::session).
    pub fn of(session: &Session) -> Option<Self> {
        let handle = session.handle();
        FOOTERS.with(|footers| {
            let mut footers = footers.borrow_mut();
            prune(&mut footers);
            footers.iter().find(|(key, _)| *key == handle).map(|(_, footer)| Self(footer.clone()))
        })
    }

    /// The renderer size for a footer of `footer_height` rows on a terminal of `terminal` cells.
    pub fn renderer_size_for(terminal: (u16, u16), footer_height: u16) -> (u16, u16) {
        (terminal.0, footer_height.max(1).min(terminal.1))
    }

    /// The terminal size in cells.
    pub fn terminal_size(&self) -> (u16, u16) {
        let state = self.0.borrow();
        (state.terminal.0 as u16, state.terminal.1 as u16)
    }

    /// The renderer size: the terminal's width and the footer's rows, or the whole terminal once [left](Self::leave).
    pub fn renderer_size(&self) -> (u16, u16) {
        let state = self.0.borrow();
        state.renderer_size()
    }

    /// The requested footer height, including a change that waits for queued snapshots.
    pub fn footer_height(&self) -> u16 {
        let state = self.0.borrow();
        match state.pending_mode {
            Some(Mode::Split(height)) => height as u16,
            _ => state.footer_height as u16,
        }
    }

    /// Whether the footer is still split from the scrollback: [`Self::leave`] has not taken effect.
    pub fn is_split(&self) -> bool {
        self.0.borrow().split_height > 0
    }

    /// Snapshots waiting for a frame.
    pub fn queued(&self) -> usize {
        self.0.borrow().queue.len()
    }

    /// The column where the scrollback's last row ends once every queued snapshot is written, as Core's
    /// `tailColumn`. A snapshot with `start_on_new_line` off continues that row.
    pub fn tail_column(&self) -> u32 {
        self.0.borrow().pending_tail_column()
    }

    /// Queues rows to append above the footer. The next frame writes them; [`App`](crate::App) paints one while
    /// any are queued. Fails, queueing nothing, for a snapshot from another Context, wider than its `row_columns`
    /// allow, or larger than one frame of Session output.
    pub fn write(&self, snapshot: SplitSnapshot) -> Result<()> {
        let mut state = self.0.borrow_mut();
        if state.split_height == 0 {
            return Err(Error::Usage("the split footer was left; scrollback writes need a split footer"));
        }
        if snapshot.buffer.context().as_raw() != state.session.context().as_raw() {
            return Err(Error::Usage("a scrollback snapshot must belong to the footer's Context"));
        }
        let (width, height) = snapshot.buffer.size();
        if snapshot.row_columns > width {
            return Err(Error::Usage("scrollback rowColumns must be at most the snapshot width"));
        }
        let cells = u64::from(width) * u64::from(height);
        if cells > state.max_cells {
            return Err(Error::Usage("scrollback snapshot exceeds the Session output capacity"));
        }
        let row_widths = row_widths(&snapshot)?;
        state.queue.push_back(Queued { snapshot, cells, row_widths });
        Ok(())
    }

    /// Changes the footer height. The renderer takes the new size once queued snapshots are written; an
    /// [`Event::Resize`](crate::input::Event::Resize) then reports it.
    pub fn set_footer_height(&self, height: u16) -> Result<()> {
        let height = u32::from(height.max(1));
        if u32::from(self.footer_height()) == height {
            return Ok(());
        }
        let mut state = self.0.borrow_mut();
        if state.split_height == 0 {
            state.footer_height = height;
            return Ok(());
        }
        state.request_mode(Mode::Split(height))
    }

    /// Leaves split-footer mode for the main screen, clearing the footer's rows, as Core does for
    /// `screenMode = "main-screen"`. It waits for queued snapshots. Call it before quitting to leave the cursor below
    /// the scrollback.
    pub fn leave(&self) -> Result<()> {
        self.0.borrow_mut().request_mode(Mode::Main)
    }

    /// Clears the screen, and with `clear_saved_lines` the terminal's scrollback, then starts the scrollback again
    /// at the top, as Core's `resetSplitFooterForReplay`. Snapshots queued before this go out first; later ones go
    /// after the reset.
    pub fn reset_for_replay(&self, clear_saved_lines: bool) -> Result<()> {
        let mut state = self.0.borrow_mut();
        if state.split_height == 0 {
            return Err(Error::Usage("reset_for_replay needs a split footer"));
        }
        if !state.writable {
            return Err(Error::Usage("reset_for_replay needs an active terminal"));
        }
        state.replay = Some(Replay { clear_saved_lines, remaining: state.queue.len() });
        if state.queue.is_empty() {
            state.apply_replay()?;
        }
        Ok(())
    }

    // Host driving.

    /// Setup finished: wait a moment for the cursor report that says where the footer starts.
    pub(crate) fn setup_done(&self, now: Instant) {
        let mut state = self.0.borrow_mut();
        state.writable = true;
        state.seed_pending = true;
        state.seed_until = now.checked_add(SEED_WAIT);
    }

    /// Native code took a cursor report: during setup, the scrollback starts at the cursor's row.
    pub(crate) fn cursor_reported(&self) -> Result<()> {
        let mut state = self.0.borrow_mut();
        if !state.seed_pending || state.split_height == 0 {
            return Ok(());
        }
        let seed_rows = state.seed_rows()?;
        state.reset(seed_rows)?;
        state.clear_transition()?;
        state.seed_pending = false;
        state.seed_until = None;
        Ok(())
    }

    /// Retire the first frame's wakeup after polling, even if the cursor report can still arrive.
    pub(crate) fn expire_seed(&self, now: Instant, expecting_replies: bool) {
        let mut state = self.0.borrow_mut();
        state.seed_pending &= expecting_replies;
        state.seed_until = state.seed_until.filter(|&until| expecting_replies && now < until);
    }

    pub(crate) fn frame_deadline(&self) -> Option<Instant> {
        let state = self.0.borrow();
        state.seed_until.filter(|_| state.split_height > 0)
    }

    /// Whether a frame should be painted: snapshots wait, or a replay reset waits for one.
    pub(crate) fn wants_frame(&self) -> bool {
        let state = self.0.borrow();
        !state.queue.is_empty() || state.replay.is_some() || state.pending_mode.is_some()
    }

    pub(crate) fn take_resized(&self) -> Option<(u16, u16)> {
        self.0.borrow_mut().resized.take().map(|(width, height)| (width as u16, height as u16))
    }

    /// Presents a footer frame with the queued snapshots that fit it.
    pub(crate) fn present(&self, mut draft: Draft, force: bool) -> Result<RenderOutcome> {
        let mut state = self.0.borrow_mut();
        // Take the footer's own request even when the host forces the frame anyway.
        let requested = std::mem::take(&mut state.force);
        let force = force || requested;
        if state.split_height == 0 {
            return draft.commit(force);
        }
        let count = match state.replay {
            Some(Replay { remaining: 0, .. }) => 0,
            replay => state.batch(replay.map_or(usize::MAX, |replay| replay.remaining)),
        };
        let snapshots: Vec<SplitSnapshot> =
            state.queue.iter().take(count).map(|queued| queued.snapshot.clone()).collect();
        let pinned = state.pinned_render_offset();
        let outcome = state.session.render_split(Some(&mut draft), &snapshots, pinned, force);
        let outcome = match outcome {
            Ok(outcome) => outcome,
            Err(error) => {
                state.force |= force;
                return Err(error);
            }
        };
        if outcome.accepted() {
            state.accepted = Some(count);
        } else {
            state.force |= force;
        }
        if outcome == RenderOutcome::Failed {
            state.dropped(count)?;
        }
        Ok(outcome)
    }

    /// Completes the snapshots of a presented frame, then applies a replay reset or mode change that waited for them.
    pub(crate) fn settle(&self) -> Result<()> {
        let mut state = self.0.borrow_mut();
        if state.session.renderer_state()?.frame_pending {
            return Ok(());
        }
        if let Some(count) = state.accepted.take() {
            state.complete(count)?;
        }
        state.apply_pending()
    }

    /// One step of writing queued snapshots without a footer frame, for suspension and close.
    pub(crate) fn drain(&self) -> Result<Drain> {
        let mut state = self.0.borrow_mut();
        if state.session.renderer_state()?.frame_pending {
            return Ok(Drain::Wait);
        }
        if let Some(count) = state.accepted.take() {
            state.complete(count)?;
        }
        if state.replay.is_some_and(|replay| replay.remaining == 0) {
            match state.apply_replay() {
                Ok(()) => {}
                Err(error) if error.status() == Some(Status::OutputBackpressure) => return Ok(Drain::Wait),
                Err(error) => return Err(error),
            }
        }
        if state.queue.is_empty() || state.split_height == 0 {
            return Ok(Drain::Done);
        }
        let count = state.batch(state.replay.map_or(usize::MAX, |replay| replay.remaining));
        let snapshots: Vec<SplitSnapshot> =
            state.queue.iter().take(count).map(|queued| queued.snapshot.clone()).collect();
        let pinned = state.pinned_render_offset();
        match state.session.render_split(None, &snapshots, pinned, false)? {
            RenderOutcome::Failed => {
                if !state.dropped(count)? {
                    return Err(Error::Usage("native split output frame failed"));
                }
                Ok(Drain::Submitted)
            }
            RenderOutcome::Skipped => Ok(Drain::Wait),
            RenderOutcome::Presented | RenderOutcome::Pending => {
                state.accepted = Some(count);
                Ok(Drain::Submitted)
            }
        }
    }

    /// Applies a mode change that waited, once nothing is queued. For close, after draining.
    pub(crate) fn apply_pending(&self) -> Result<()> {
        self.0.borrow_mut().apply_pending()
    }

    /// The terminal changed size. Returns the new renderer size, or `None` while queued snapshots must go first.
    pub(crate) fn resize(&self, width: u16, height: u16) -> Result<Option<(u16, u16)>> {
        let mut state = self.0.borrow_mut();
        state.resize(u32::from(width), u32::from(height))
    }

    pub(crate) fn suspended(&self) {
        let mut state = self.0.borrow_mut();
        state.writable = false;
        state.seed_pending = false;
        state.seed_until = None;
    }

    /// Before resuming: native resume needs no deferred transition.
    pub(crate) fn before_resume(&self) -> Result<()> {
        let state = self.0.borrow();
        if state.transition.is_some() {
            state.session.split_control(SplitControl::ClearTransition)?;
        }
        Ok(())
    }

    pub(crate) fn resumed(&self) -> Result<()> {
        let mut state = self.0.borrow_mut();
        state.writable = true;
        if let Some(transition) = state.transition {
            state.session.split_control(SplitControl::Transition(transition))?;
        }
        if state.split_height > 0 {
            state.sync()?;
        }
        state.force = true;
        Ok(())
    }
}

impl State {
    /// Whether frames still wait for setup's cursor report: Core's `isSplitCursorSeedFrameBlocked`.
    fn seed_blocks(&self, now: Instant) -> bool {
        self.seed_until.is_some_and(|until| now < until)
    }

    fn renderer_size(&self) -> (u16, u16) {
        let height = if self.split_height == 0 { self.terminal.1 } else { self.split_height };
        (self.terminal.0 as u16, height as u16)
    }

    fn pinned_render_offset(&self) -> u32 {
        if self.split_height == 0 { 0 } else { self.terminal.1.saturating_sub(self.split_height) }
    }

    fn seed_rows(&self) -> Result<u32> {
        let row = self.session.cursor_row()?.max(1);
        Ok(row.min(self.terminal.1.max(1)))
    }

    fn reset(&mut self, seed_rows: u32) -> Result<()> {
        let pinned_render_offset = self.pinned_render_offset();
        self.render_offset = self.session.split_control(SplitControl::Reset { seed_rows, pinned_render_offset })?;
        self.tail_column = 0;
        Ok(())
    }

    fn sync(&mut self) -> Result<()> {
        let pinned_render_offset = self.pinned_render_offset();
        self.render_offset = self.session.split_control(SplitControl::Sync { pinned_render_offset })?;
        Ok(())
    }

    fn output_offset(&self, surface_offset: u32) -> Result<u32> {
        self.session.split_control(SplitControl::OutputOffset { surface_offset })
    }

    fn set_render_offset(&mut self, offset: u32) -> Result<()> {
        self.session.split_control(SplitControl::RenderOffset { offset })?;
        self.render_offset = offset;
        Ok(())
    }

    fn clear_transition(&mut self) -> Result<()> {
        if self.transition.take().is_some() {
            self.session.split_control(SplitControl::ClearTransition)?;
        }
        Ok(())
    }

    fn set_transition(&mut self, transition: SplitTransition) -> Result<()> {
        self.session.split_control(SplitControl::Transition(transition))?;
        self.transition = Some(transition);
        Ok(())
    }

    /// The head snapshots, at most `limit` and this frame's commit limit, that fit one frame of output.
    fn batch(&self, limit: usize) -> usize {
        let limit = limit.min(self.commit_limit).min(self.queue.len());
        let mut cells = 0;
        let mut count = 0;
        while count < limit {
            cells += self.queue[count].cells;
            if cells > self.max_cells {
                break;
            }
            count += 1;
        }
        count
    }

    fn complete(&mut self, count: usize) -> Result<()> {
        self.sync()?;
        let width = self.terminal.0.max(1);
        for queued in self.queue.drain(..count.min(self.queue.len())) {
            self.tail_column = tail_after(&queued, self.tail_column, width);
        }
        if let Some(replay) = &mut self.replay {
            replay.remaining = replay.remaining.saturating_sub(count);
        }
        self.commit_limit = COMMITS_PER_FRAME;
        self.transition = None;
        Ok(())
    }

    /// After a failed frame: whether it was dropped for its size. A batch then goes again one snapshot at a time,
    /// and a single snapshot is dropped, as in Core.
    fn dropped(&mut self, count: usize) -> Result<bool> {
        if self.session.renderer_state()?.dropped_frame_bytes == 0 {
            return Ok(false);
        }
        if count > 1 {
            self.commit_limit = 1;
        } else if count == 1 {
            self.queue.pop_front();
            if let Some(replay) = &mut self.replay {
                replay.remaining = replay.remaining.saturating_sub(1);
            }
        }
        Ok(true)
    }

    fn pending_tail_column(&self) -> u32 {
        let width = self.terminal.0.max(1);
        let skipped = self.replay.map_or(0, |replay| replay.remaining);
        let start = if self.replay.is_some() { 0 } else { self.tail_column };
        self.queue.iter().skip(skipped).fold(start, |tail, queued| tail_after(queued, tail, width))
    }

    fn request_mode(&mut self, mode: Mode) -> Result<()> {
        self.pending_mode = Some(mode);
        self.apply_pending()
    }

    fn apply_pending(&mut self) -> Result<()> {
        if self.replay.is_some_and(|replay| replay.remaining == 0) {
            match self.apply_replay() {
                Err(error) if error.status() == Some(Status::OutputBackpressure) => return Ok(()),
                result => result?,
            }
        }
        if !self.queue.is_empty() || self.accepted.is_some() {
            return Ok(());
        }
        let Some(mode) = self.pending_mode else { return Ok(()) };
        match self.apply_mode(mode) {
            Ok(()) => {
                self.pending_mode = None;
                Ok(())
            }
            Err(error) if matches!(error.status(), Some(Status::OutputBusy | Status::FrameBusy)) => Ok(()),
            Err(error) => Err(error),
        }
    }

    fn apply_replay(&mut self) -> Result<()> {
        let Some(replay) = self.replay else { return Ok(()) };
        let mut bytes = b"\x1b[r\x1b[0m\x1b[H\x1b[2J".to_vec();
        if replay.clear_saved_lines {
            bytes.extend_from_slice(b"\x1b[3J");
        }
        bytes.extend_from_slice(b"\x1b[H");
        self.session.write(&bytes)?;
        self.seed_pending = false;
        self.seed_until = None;
        self.clear_transition()?;
        self.reset(0)?;
        self.replay = None;
        self.force = true;
        Ok(())
    }

    /// Core's `applyScreenMode` from split-footer, to another footer height or to the main screen.
    fn apply_mode(&mut self, mode: Mode) -> Result<()> {
        if self.split_height == 0 {
            if let Mode::Split(height) = mode {
                self.footer_height = height;
            }
            return Ok(());
        }
        let footer_height = match mode {
            Mode::Split(height) => height,
            Mode::Main => self.footer_height,
        };
        let (terminal_width, terminal_height) = self.terminal;
        let previous_split = self.split_height;
        let next_split = match mode {
            Mode::Split(height) => height.min(terminal_height),
            Mode::Main => 0,
        };
        if mode != Mode::Main && previous_split == next_split {
            self.footer_height = footer_height;
            return Ok(());
        }
        let writable = self.writable;
        let leaving = next_split == 0;
        let defer = writable && !leaving;
        let seed_blocks = self.seed_blocks(Instant::now());
        let source_top = self.transition.map_or(self.render_offset + 1, |transition| transition.source_top);
        let source_height = self.transition.map_or(previous_split, |transition| transition.source_height);
        let source_surface = source_top.saturating_sub(1);
        let source_output = self.output_offset(source_surface)?;
        let next_pinned = terminal_height - next_split;
        let next_output = if leaving { next_pinned } else { self.output_offset(next_pinned)? };
        let transition = self.transition;
        let returning = transition.is_some() && next_split == source_height;
        let viewport_return = returning
            && transition.is_some_and(|transition| {
                transition.mode == TransitionMode::ViewportScroll && transition.scroll_rows > 0
            });
        let shrinking = next_split > 0 && next_split < source_height;
        let growing = next_split > source_height && source_height > 0;
        let next_surface = if leaving {
            0
        } else if viewport_return {
            transition.map_or(0, |transition| transition.target_top.saturating_sub(1))
        } else if returning || (shrinking && source_surface > 0) {
            source_surface
        } else if shrinking {
            next_output
        } else if growing {
            next_output.max(source_surface.min(next_pinned))
        } else {
            next_pinned
        };
        let target_top = next_surface + 1;
        let scroll_rows = if viewport_return {
            transition.map_or(0, |transition| transition.scroll_rows)
        } else if next_split > 0 && !returning {
            source_output.saturating_sub(next_output)
        } else {
            0
        };
        let transition_mode = if (!shrinking || viewport_return) && scroll_rows > 0 {
            TransitionMode::ViewportScroll
        } else {
            TransitionMode::ClearStaleRows
        };
        let output = if writable && leaving { format!("\x1b[{source_top};1H\x1b[J") } else { String::new() };
        let render_height = if leaving { terminal_height } else { next_split };
        self.session.set_screen(false, terminal_width, render_height, output.as_bytes())?;
        self.footer_height = footer_height;
        self.split_height = next_split;
        self.resized = Some((terminal_width, render_height));
        if writable && leaving {
            self.clear_transition()?;
            self.set_render_offset(0)?;
        }
        if leaving {
            self.clear_transition()?;
            self.reset(0)?;
            return self.set_render_offset(0);
        }
        self.set_render_offset(next_surface)?;
        if defer {
            if seed_blocks {
                self.clear_transition()?;
            } else {
                self.set_transition(SplitTransition {
                    mode: transition_mode,
                    source_top,
                    source_height,
                    target_top,
                    target_height: next_split,
                    scroll_rows,
                })?;
            }
            self.force = true;
        } else {
            self.clear_transition()?;
        }
        Ok(())
    }

    /// Core's `processResize` for a split footer.
    fn resize(&mut self, width: u32, height: u32) -> Result<Option<(u16, u16)>> {
        if (width, height) == self.terminal {
            return Ok(Some(self.renderer_size()));
        }
        let seed_blocks = self.seed_blocks(Instant::now());
        if self.writable && !seed_blocks && !self.queue.is_empty() {
            return Ok(None);
        }
        let (previous_width, previous_height) = self.terminal;
        let visible_previous = self.transition.map_or(self.split_height, |transition| transition.source_height);
        let next_split = if self.split_height == 0 { 0 } else { self.footer_height.min(height) };
        let render_height = if next_split == 0 { height } else { next_split };
        let mut clear_start: Option<u32> = None;
        if self.writable && self.split_height > 0 {
            if width < previous_width && visible_previous > 0 {
                clear_start =
                    Some((self.render_offset + 1).min(previous_height.saturating_sub(visible_previous * 2).max(1)));
            }
            if let Some(transition) = self.transition {
                clear_start = Some(clear_start.map_or(transition.source_top, |start| start.min(transition.source_top)));
            }
        }
        match clear_start {
            None => self.session.resize(width, render_height)?,
            Some(start) => {
                self.session.set_screen(false, width, render_height, format!("\x1b[{start};1H\x1b[J").as_bytes())?
            }
        }
        self.terminal = (width, height);
        self.split_height = next_split;
        if next_split > 0 {
            self.force = true;
        }
        self.clear_transition()?;
        if next_split > 0 {
            self.sync()?;
        }
        Ok(Some(self.renderer_size()))
    }
}

/// The tail column after appending `queued`, Core's `getSplitTailColumnAfterCommit`.
fn tail_after(queued: &Queued, tail: u32, width: u32) -> u32 {
    let mut tail = if queued.snapshot.start_on_new_line && tail > 0 { 0 } else { tail };
    let last = queued.row_widths.len().saturating_sub(1);
    for (index, &columns) in queued.row_widths.iter().enumerate() {
        tail = advance(tail, columns, width);
        if index < last || queued.snapshot.trailing_newline {
            tail = 0;
        }
    }
    tail
}

/// Core's `advanceSplitTailColumn`: where a row of `columns` cells written at `tail` ends, wrapping at `width`.
fn advance(mut tail: u32, columns: u32, width: u32) -> u32 {
    let mut remaining = columns;
    while remaining > 0 {
        if tail >= width {
            tail = 0;
        }
        let step = remaining.min(width - tail);
        tail += step;
        remaining -= step;
        if remaining > 0 && tail >= width {
            tail = 0;
        }
    }
    tail
}

/// Columns of each row up to `row_columns`, without trailing empty cells, as Core's `snapshotRowWidths`. The
/// continuation cells of a trailing wide character stay: they take terminal columns.
fn row_widths(snapshot: &SplitSnapshot) -> Result<Vec<u32>> {
    let buffer = &snapshot.buffer;
    let mut raw = sys::ot_buffer_lease_snapshot::default();
    let (context, handle) = (buffer.context().as_raw(), buffer.handle());
    crate::error::check("ot_buffer_acquire_lease", unsafe {
        sys::ot_buffer_acquire_lease(context, &handle, &mut raw)
    })?;
    let mut lease = Lease { context, snapshot: raw };
    let planes = lease.planes();
    let width = planes.width as usize;
    Ok((0..planes.height as usize)
        .map(|y| {
            let row = &planes.chars[y * width..(y + 1) * width];
            let mut x = (snapshot.row_columns as usize).min(width);
            while x > 0 && row[x - 1] == 0 {
                x -= 1;
            }
            x as u32
        })
        .collect())
}

#[cfg(test)]
mod tests {
    use super::advance;

    #[test]
    fn tail_columns_wrap_at_the_width() {
        assert_eq!(advance(0, 5, 10), 5);
        assert_eq!(advance(5, 5, 10), 10);
        assert_eq!(advance(10, 3, 10), 3);
        assert_eq!(advance(8, 5, 10), 3);
        assert_eq!(advance(4, 0, 10), 4);
    }
}
