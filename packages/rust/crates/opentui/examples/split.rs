//! A prompt in a footer at the bottom of the main screen, writing what you type into the scrollback above it, the
//! way OpenCode's `mini` uses Core's split-footer renderer.
//!
//! Run with `sh run.sh split`. Type a line and press Enter to write it above the footer. Ctrl+G grows or shrinks the
//! footer, Ctrl+L clears the screen and the scrollback and writes the transcript again, and Esc or Ctrl+C leaves.

use opentui::native::MouseTracking;
use opentui::prelude::*;
use opentui::split::{Scrollback, SnapshotOptions, SplitFooter};
use std::cell::RefCell;
use std::rc::Rc;

const FOOTER_HEIGHT: u16 = 4;

fn main() -> opentui::Result<()> {
    let mut options = AppOptions { exit_on_ctrl_c: false, ..AppOptions::default() };
    options.host.split_footer = Some(FOOTER_HEIGHT);
    options.host.terminal.mouse = MouseTracking::Off;
    let app = App::new(options)?;
    let theme = app.theme();
    let footer = SplitFooter::of(app.session()).expect("the app runs in a split footer");
    let scrollback = Scrollback::new(&app)?;

    let status = Text::new(&app, "").fg(theme.muted);
    let prompt = Input::new(&app);
    app.root()
        .padding_x(1)
        .child(&View::new(&app).border(BorderStyle::Rounded).border_color(theme.accent).child(&prompt))
        .child(&status);
    let show_size = {
        let (status, footer) = (status.clone(), footer.clone());
        move |app: &App| {
            let (width, height) = footer.terminal_size();
            let rows = app.size().1;
            status.set_text(format!("{width}x{height}, {rows}-row footer · Ctrl+G Ctrl+L Esc"));
        }
    };
    show_size(&app);
    app.on_resize(move |cx, _, _| show_size(cx.app()));

    // Each entry is written once; a replay writes them all again after clearing the terminal.
    let transcript: Rc<RefCell<Vec<String>>> = Rc::default();
    let write = {
        let (footer, scrollback) = (footer.clone(), scrollback.clone());
        move |line: &str| -> opentui::Result<()> {
            let row = Text::new(scrollback.app(), vec!["› ".fg(theme.accent), line.into()]);
            footer.write(scrollback.snapshot(&row, SnapshotOptions::default())?)
        }
    };
    write("Split footer example. Type below.")?;

    prompt.on_submit({
        let (prompt, transcript, write) = (prompt.clone(), transcript.clone(), write.clone());
        move |cx, value| {
            let line = value.trim().to_owned();
            if line.is_empty() {
                return;
            }
            check(cx, write(&line));
            transcript.borrow_mut().push(line);
            prompt.set_value("");
        }
    });
    app.on_key(move |cx, key| {
        if key.matches("escape") || key.matches("ctrl+c") {
            check(cx, footer.leave());
            cx.quit();
        } else if key.matches("ctrl+g") {
            let height = if footer.footer_height() == FOOTER_HEIGHT { FOOTER_HEIGHT + 4 } else { FOOTER_HEIGHT };
            check(cx, footer.set_footer_height(height));
        } else if key.matches("ctrl+l") {
            check(cx, footer.reset_for_replay(true));
            for line in transcript.borrow().iter() {
                check(cx, write(line));
            }
        }
    });
    prompt.focus();
    app.run()
}

/// Ends the app with a failure, as the event loop does for its own errors.
fn check(cx: &mut Cx<'_>, result: opentui::Result<()>) {
    if let Err(error) = result {
        cx.fail(error);
    }
}
