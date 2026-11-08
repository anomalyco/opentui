//! A footer at the bottom of the main screen with scrollback written above it, as Core's split-footer renderer.
//!
//! Set [`HostOptions::split_footer`](crate::host::HostOptions::split_footer) to the footer's rows. The app's
//! renderer then covers only the footer, and its root lays out in those rows. [`SplitFooter::of`] finds the
//! footer for the app's Session; [`Scrollback`] paints widgets into [`SplitSnapshot`]s to [`SplitFooter::write`]
//! above it. The next frame appends the queued snapshots and repaints the footer in one write. Resizes, footer height
//! changes, replay resets, suspension, and close follow Core's renderer in `screenMode: "split-footer"` with
//! `externalOutputMode: "capture-stdout"`.
//!
//! ```no_run
//! use opentui::prelude::*;
//! use opentui::split::{Scrollback, SnapshotOptions, SplitFooter};
//!
//! fn main() -> opentui::Result<()> {
//!     let mut options = AppOptions::default();
//!     options.host.split_footer = Some(3);
//!     let app = App::new(options)?;
//!     let footer = SplitFooter::of(app.session()).expect("a split footer");
//!     let scrollback = Scrollback::new(&app)?;
//!     app.root().add(&Text::new(&app, "Type a line; Enter writes it above. Esc quits."));
//!     let input = Input::new(&app);
//!     app.root().add(&input);
//!     input.focus();
//!     app.on_key(move |cx, key| {
//!         if key.matches("escape") {
//!             let _ = footer.leave();
//!             cx.quit();
//!         }
//!         if key.matches("return") {
//!             let row = Text::new(scrollback.app(), input.value());
//!             if let Ok(snapshot) = scrollback.snapshot(&row, SnapshotOptions::default()) {
//!                 let _ = footer.write(snapshot);
//!             }
//!             input.set_value("");
//!         }
//!     });
//!     app.run()
//! }
//! ```
//!
//! Core also captures what the process writes to stdout into the scrollback; this module does not.

mod footer;
mod native;
mod scrollback;

pub(crate) use footer::Drain;
pub use footer::SplitFooter;
pub use native::{SPLIT_SNAPSHOTS_MAX, SplitControl, SplitSnapshot, SplitTransition, TransitionMode};
pub use scrollback::{Scrollback, ScrollbackSurface, SnapshotOptions};
