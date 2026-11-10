//! Asking the terminal for its palette again while the app runs, as Core's `getPalette` does after
//! `clearPaletteCache`. The startup palette comes from [`App::new`](super::App::new) before the terminal is set up.

use super::{App, Cx, TimerId};
use crate::input::OscColor;
use crate::native::Control;
use crate::term::TerminalPalette;
use std::time::Duration;

/// How long a refresh waits for the terminal's answers before it reports what came.
const REFRESH_WAIT: Duration = Duration::from_secs(1);

/// A palette refresh waiting for the terminal's replies.
pub(super) struct Refresh {
    palette: TerminalPalette,
    timer: TimerId,
    /// Another refresh was asked for while this one ran.
    again: bool,
}

impl App {
    /// Asks the terminal for its first [`AppOptions::palette_size`](super::AppOptions::palette_size) palette colors
    /// and its default and cursor colors again, such as after [`Self::on_color_scheme`]. When every color has come,
    /// or after a second with at least one, [`Self::palette`] returns the new colors and the [`Self::on_palette`]
    /// handlers run. One refresh runs at a time; a call while one runs starts another after it. Does nothing when
    /// `palette_size` is 0.
    pub fn refresh_palette(&self) {
        let size = self.0.options.palette_size.min(256);
        if size == 0 {
            return;
        }
        if let Some(refresh) = self.0.palette_refresh.borrow_mut().as_mut() {
            refresh.again = true;
            return;
        }
        if self.0.terminal_active.get() {
            let mut request: Vec<u8> =
                (0..size).flat_map(|index| format!("\x1b]4;{index};?\x07").into_bytes()).collect();
            request.extend_from_slice(b"\x1b]10;?\x07\x1b]11;?\x07\x1b]12;?\x07");
            // A terminal that refuses the query answers nothing, and the wait ends the refresh.
            let _ = self.0.session.control(Control::PaletteQuery(&request));
        }
        let timer = self.set_timeout(REFRESH_WAIT, |cx| cx.app().finish_palette_refresh());
        let palette = TerminalPalette { colors: vec![None; usize::from(size)], ..TerminalPalette::default() };
        *self.0.palette_refresh.borrow_mut() = Some(Refresh { palette, timer, again: false });
    }

    /// Called with the terminal's colors after [`Self::refresh_palette`].
    pub fn on_palette(&self, mut handler: impl FnMut(&mut Cx<'_>, &TerminalPalette) + 'static) -> super::HandlerId {
        self.0.handlers.palette.add(move |cx, palette: &TerminalPalette| handler(cx, palette))
    }

    /// Called when the terminal says its color scheme changed. The theme mode follows by itself
    /// ([`Self::on_theme_mode`]); call [`Self::refresh_palette`] here to read the new palette.
    pub fn on_color_scheme(&self, mut handler: impl FnMut(&mut Cx<'_>) + 'static) -> super::HandlerId {
        self.0.handlers.color_scheme.add(move |cx, (): &()| handler(cx))
    }

    /// Records a color the terminal reported, for the refresh waiting for it.
    pub(super) fn palette_color(&self, color: OscColor) {
        let complete = {
            let mut refresh = self.0.palette_refresh.borrow_mut();
            let Some(refresh) = refresh.as_mut() else { return };
            let palette = &mut refresh.palette;
            match color {
                OscColor::Palette(index, color) => {
                    if let Some(slot) = palette.colors.get_mut(usize::from(index)) {
                        *slot = Some(color);
                    }
                }
                OscColor::Foreground(color) => palette.foreground = Some(color),
                OscColor::Background(color) => palette.background = Some(color),
                OscColor::Cursor(color) => palette.cursor = Some(color),
            }
            palette.colors.iter().all(Option::is_some)
                && palette.foreground.is_some()
                && palette.background.is_some()
                && palette.cursor.is_some()
        };
        if complete {
            self.finish_palette_refresh();
        }
    }

    fn finish_palette_refresh(&self) {
        let Some(refresh) = self.0.palette_refresh.borrow_mut().take() else { return };
        self.cancel_timer(refresh.timer);
        let palette = refresh.palette;
        let answered =
            palette.foreground.is_some() || palette.background.is_some() || palette.colors.iter().any(Option::is_some);
        if answered {
            if self.0.terminal_active.get() {
                self.publish_palette(&palette);
            }
            *self.0.palette.borrow_mut() = Some(palette.clone());
            self.request_redraw();
            self.0.handlers.palette.emit(&mut Cx::new(self), &palette);
        }
        if refresh.again {
            self.refresh_palette();
        }
    }

    /// Gives native code the palette it picks colors from.
    pub(super) fn publish_palette(&self, palette: &TerminalPalette) {
        // Native code needs a gapless palette: publish the entries up to the first the terminal did not report.
        let known: Vec<_> = palette.colors.iter().map_while(|color| *color).collect();
        let epoch = self.0.palette_epoch.get() + 1;
        self.0.palette_epoch.set(epoch);
        let _ = self.0.session.set_palette_state(&known, palette.foreground, palette.background, epoch);
    }
}
