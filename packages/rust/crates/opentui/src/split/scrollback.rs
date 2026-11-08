//! Rendering widgets into scrollback snapshots, as Core's `writeToScrollback` and `createScrollbackSurface`.

use super::native::SplitSnapshot;
use crate::app::{App, AppOptions};
use crate::error::{Error, Result};
use crate::layout::{Edge, FlexDirection};
use crate::native::{Buffer, Draft, Remote, Session, SessionOptions};
use crate::style::Color;
use crate::theme::Theme;
use crate::widget::{Container, View, Widget};
use std::cell::{Cell, RefCell};
use std::rc::Rc;

/// Measuring passes before a snapshot keeps the last height, as in Core.
const HEIGHT_PASSES: u32 = 4;

/// How [`Scrollback::snapshot`] sizes and joins a snapshot.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct SnapshotOptions {
    /// Columns; the parent renderer's width by default.
    pub width: Option<u32>,
    /// Rows; the content's height by default.
    pub height: Option<u32>,
    /// Columns of each row to write; the whole width by default.
    pub row_columns: Option<u32>,
    pub start_on_new_line: bool,
    pub trailing_newline: bool,
}

impl Default for SnapshotOptions {
    /// Core's defaults: full rows on a new line, ending with a newline.
    fn default() -> Self {
        Self { width: None, height: None, row_columns: None, start_on_new_line: true, trailing_newline: true }
    }
}

/// Paints widgets offscreen into [`SplitSnapshot`]s for a [`SplitFooter`](super::SplitFooter).
///
/// It owns a detached app in the parent app's Context: build the widgets with [`Self::app`], then render them with
/// [`Self::snapshot`] or a [`ScrollbackSurface`]. The detached app takes the parent's detected terminal state before
/// each paint, so text measures as it does in the footer. Its background is transparent.
///
/// Cloning shares the same detached app.
#[derive(Clone)]
pub struct Scrollback(Rc<Inner>);

struct Inner {
    app: App,
    session: Session,
    parent: Session,
}

impl std::fmt::Debug for Scrollback {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter.debug_struct("Scrollback").finish_non_exhaustive()
    }
}

impl Scrollback {
    /// A writer for `parent`'s scrollback. Widgets start with the parent's theme, on a transparent background.
    pub fn new(parent: &App) -> Result<Self> {
        Self::for_session(parent.session(), parent.theme())
    }

    /// A writer for the scrollback of a Session driven without an [`App`], such as a
    /// [`Host`](crate::host::Host)'s. Widgets start with `theme`, on a transparent background.
    pub fn for_session(parent: &Session, theme: Theme) -> Result<Self> {
        let session = Session::new(
            parent.context(),
            SessionOptions { chunk_size: 4096, span_capacity: 4, max_bytes: 8192, control_capacity: 0 },
        )?;
        let renderer = parent.renderer_state()?;
        session.attach_renderer(renderer.width.max(1), 1, Remote::Remote, &[])?;
        session.sync_detached(parent)?;
        let theme = Theme { background: Color::TRANSPARENT, ..theme };
        let app = App::detached(session.clone(), AppOptions::default().with_theme(theme))?;
        // The detached app never runs; messages logged meanwhile belong to the parent.
        crate::console::unregister(app.console_id());
        Ok(Self(Rc::new(Inner { app, session, parent: parent.clone() })))
    }

    /// The detached app to build snapshot widgets with.
    pub fn app(&self) -> &App {
        &self.0.app
    }

    /// Renders `root` into a snapshot, as Core's `writeToScrollback` does with a writer's root.
    pub fn snapshot(&self, root: &impl Widget, options: SnapshotOptions) -> Result<SplitSnapshot> {
        let width = self.width(options.width)?;
        let holder = self.holder(width);
        holder.add(root);
        let rendered = self.render(&holder, width, options.height, options.height.unwrap_or(1));
        holder.detach();
        let (buffer, _) = rendered?;
        Ok(SplitSnapshot {
            row_columns: options.row_columns.unwrap_or(width).min(width),
            buffer,
            start_on_new_line: options.start_on_new_line,
            trailing_newline: options.trailing_newline,
        })
    }

    /// A surface for content that grows, such as streaming text, whose finished rows are committed as they settle.
    pub fn surface(&self, start_on_new_line: bool) -> Result<ScrollbackSurface> {
        let width = self.width(None)?;
        let holder = self.holder(width).visible(false);
        Ok(ScrollbackSurface {
            scrollback: self.clone(),
            holder,
            rendered: RefCell::new(None),
            width: Cell::new(width),
            next_start_on_new_line: Cell::new(start_on_new_line),
        })
    }

    fn width(&self, width: Option<u32>) -> Result<u32> {
        Ok(match width {
            Some(width) => width.max(1),
            None => self.0.parent.renderer_state()?.width.max(1),
        })
    }

    /// An absolute column of `width` cells and automatic height, so its height is the content's.
    fn holder(&self, width: u32) -> View {
        let holder = View::new(&self.0.app)
            .absolute()
            .position(Edge::Left, 0)
            .position(Edge::Top, 0)
            .width(width)
            .direction(FlexDirection::Column);
        self.0.app.root().add(&holder);
        holder
    }

    /// Paints `holder` at `width` until its height settles, starting from `rows`, or at a fixed `height`, and copies
    /// it into a new buffer.
    fn render(&self, holder: &View, width: u32, height: Option<u32>, rows: u32) -> Result<(Buffer, u32)> {
        let inner = &self.0;
        inner.session.sync_detached(&inner.parent)?;
        let mut rows = height.unwrap_or(rows).max(1);
        let mut pass = 0;
        let draft = loop {
            inner.session.resize(width, rows)?;
            let draft: Draft = inner.app.paint_with(true)?;
            let measured = (holder.rect().height.max(0.0) as u32).max(1);
            if height.is_some() || pass == HEIGHT_PASSES || measured == rows {
                break draft;
            }
            drop(draft);
            rows = measured;
            pass += 1;
        };
        let width_method = inner.parent.capabilities()?.width_method;
        let buffer = Buffer::new(inner.parent.context(), width, rows, width_method)?;
        draft.copy_to(&buffer)?;
        Ok((buffer, rows))
    }
}

/// Content rendered offscreen whose rows are committed to the scrollback in parts, as Core's `ScrollbackSurface`.
///
/// Add widgets to [`Self::root`], [`render`](Self::render), then [`commit_rows`](Self::commit_rows) the rows that
/// are final. Render again after the content or the terminal width changes; rows can only be committed from the
/// latest render. Dropping the surface removes its widgets.
pub struct ScrollbackSurface {
    scrollback: Scrollback,
    holder: View,
    /// The latest render's cells and the renderer width it was made at.
    rendered: RefCell<Option<(Buffer, u32)>>,
    width: Cell<u32>,
    next_start_on_new_line: Cell<bool>,
}

impl std::fmt::Debug for ScrollbackSurface {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter.debug_struct("ScrollbackSurface").field("width", &self.width.get()).finish_non_exhaustive()
    }
}

impl Drop for ScrollbackSurface {
    fn drop(&mut self) {
        self.holder.detach();
    }
}

impl ScrollbackSurface {
    /// The column to add content to: as wide as the renderer, as tall as its content.
    pub fn root(&self) -> &View {
        &self.holder
    }

    /// Renders the content at the renderer's current width.
    pub fn render(&self) -> Result<()> {
        let width = self.scrollback.width(None)?;
        self.width.set(width);
        self.holder.width(width).visible(true);
        let height = self.rendered.borrow().as_ref().map_or(1, |(buffer, _)| buffer.size().1);
        // Start from the last height, as Core does; measuring then settles on the content's.
        let result = self.scrollback.render(&self.holder, width, None, height);
        self.holder.visible(false);
        let (buffer, _) = result?;
        *self.rendered.borrow_mut() = Some((buffer, width));
        Ok(())
    }

    /// Rows of the latest render.
    pub fn height(&self) -> u32 {
        self.rendered.borrow().as_ref().map_or(0, |(buffer, _)| buffer.size().1)
    }

    /// Copies rows `start..end` of the latest render into a snapshot. The first commit starts on a new line when the
    /// surface was made so; later ones continue. Fails without a render at the current width, or for rows outside it.
    pub fn commit_rows(
        &self,
        start: u32,
        end: u32,
        row_columns: Option<u32>,
        trailing_newline: bool,
    ) -> Result<Option<SplitSnapshot>> {
        let rendered = self.rendered.borrow();
        let Some((source, width)) = rendered.as_ref() else {
            return Err(Error::Usage("ScrollbackSurface::commit_rows needs a render first"));
        };
        if *width != self.scrollback.width(None)? {
            return Err(Error::Usage("ScrollbackSurface::commit_rows needs a render after the width changed"));
        }
        if start > end || end > source.size().1 {
            return Err(Error::Usage("ScrollbackSurface::commit_rows rows are outside the render"));
        }
        if start == end {
            return Ok(None);
        }
        let parent = &self.scrollback.0.parent;
        let buffer = Buffer::new(parent.context(), *width, end - start, parent.capabilities()?.width_method)?;
        buffer.compose(source, 0, -(start as i32))?;
        let start_on_new_line = self.next_start_on_new_line.replace(false);
        Ok(Some(SplitSnapshot {
            buffer,
            row_columns: row_columns.unwrap_or(*width).min(*width),
            start_on_new_line,
            trailing_newline,
        }))
    }
}
