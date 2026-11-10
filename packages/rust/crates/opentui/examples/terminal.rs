//! Your shell in a terminal widget, beside a notes field to show that focus moves between them.
//!
//! Run with `sh run.sh terminal`. Ctrl+Q quits, Ctrl+O moves focus between the shell and the notes, and leaving the
//! shell quits too.

use opentui::prelude::*;
use opentui::pty;

fn main() -> opentui::Result<()> {
    let app = App::new(AppOptions::default())?;
    let theme = app.theme();

    let terminal = TerminalView::new(&app).grow(1.0);
    let shell =
        View::new(&app).border(BorderStyle::Rounded).highlight_focus().title(" shell ").grow(1.0).child(&terminal);
    let notes = Textarea::new(&app).placeholder("Notes").grow(1.0);
    let side = View::new(&app).border(BorderStyle::Rounded).highlight_focus().title(" notes ").width(30).child(&notes);
    let status = Text::new(&app, "").fg(theme.muted);
    app.root().add(&View::new(&app).row().grow(1.0).child(&shell).child(&side)).add(&status);

    let help = " Ctrl+Q quits · Ctrl+O switches focus";
    terminal.on_terminal_resize({
        let status = status.clone();
        move |_cx, cols, rows| {
            status.set_text(format!("{help} · {cols}x{rows}"));
        }
    });
    terminal.on_exit(|cx, _status| cx.quit());
    terminal.spawn(pty::shell())?;

    // Capture handlers run before the focused widget, so these work while the shell takes every key.
    app.on_key_capture({
        let (terminal, notes) = (terminal.clone(), notes.clone());
        move |cx, key| {
            if key.matches("ctrl+q") {
                cx.quit();
                cx.stop_propagation();
            } else if key.matches("ctrl+o") {
                if terminal.is_focused() {
                    notes.focus();
                } else {
                    terminal.focus();
                }
                cx.stop_propagation();
            }
        }
    });
    terminal.focus();
    app.run()
}
